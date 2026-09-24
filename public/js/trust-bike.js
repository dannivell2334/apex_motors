(function () {
  if (document.getElementById('apexTrustBike')) return;

  var messages = [
    '100% Genuine TVS units & spare parts',
    'Secure payments powered by Paystack',
    'Price confirmed on WhatsApp before you pay',
    'Nationwide delivery to your state',
    'Full factory warranty on every unit',
    'Trusted by dealers & riders across Nigeria'
  ];

  var css = '' +
    '#apexTrustBike{position:relative;height:46px;margin-top:14px;pointer-events:none;overflow:hidden;font-family:Inter,ui-sans-serif,system-ui,sans-serif}' +
    '#apexTrustBike .atb-road{position:absolute;left:0;right:0;bottom:0;height:3px;background:repeating-linear-gradient(90deg,#f59e0b 0 18px,transparent 18px 26px);opacity:.75}' +
    '#apexTrustBike .atb-unit{position:absolute;left:-480px;bottom:2px;display:flex;flex-direction:row-reverse;align-items:flex-end;gap:12px;animation:atbDrive 26s linear infinite;will-change:left}' +
    '#apexTrustBike .atb-sign{background:rgba(15,23,42,.95);border:1px solid rgba(245,158,11,.5);color:#fff;font-size:12px;font-weight:700;letter-spacing:.02em;padding:6px 14px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.35);margin-bottom:5px;white-space:nowrap;transition:opacity .35s ease}' +
    '#apexTrustBike .atb-bike{filter:drop-shadow(0 3px 6px rgba(0,0,0,.4));height:36px;width:auto;display:block}' +
    '#apexTrustBike .atb-spin{animation:atbSpin .9s linear infinite;transform-box:fill-box;transform-origin:center}' +
    '#apexTrustBike:hover .atb-unit{animation-play-state:paused}' +
    '@keyframes atbDrive{from{left:-480px}to{left:100%}}' +
    '@keyframes atbSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' +
    '@media (prefers-reduced-motion:reduce){#apexTrustBike{display:none}}' +
    '@media (max-width:640px){#apexTrustBike .atb-sign{font-size:10px;padding:5px 10px}}';

  var bikeImg = '<img src="/images/animated-bike.png" alt="Apex delivery bike" class="atb-bike">';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var bar = document.createElement('div');
  bar.id = 'apexTrustBike';
  bar.innerHTML = '<div class="atb-road"></div>' +
    '<div class="atb-unit">' + bikeImg + '' +
    '<div class="atb-sign">' + messages[0] + '</div></div>';

  var host = document.querySelector('footer');
  if (host) host.appendChild(bar);
  else document.body.appendChild(bar);

  var sign = bar.querySelector('.atb-sign');
  var idx = 0;
  setInterval(function () {
    idx = (idx + 1) % messages.length;
    sign.style.opacity = '0';
    setTimeout(function () {
      sign.textContent = messages[idx];
      sign.style.opacity = '1';
    }, 350);
  }, 4500);
})();