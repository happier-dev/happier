export function normalizeAuthLoginContext(raw) {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (v === 'selfhost' || v === 'self-host' || v === 'self_host') return 'selfhost';
  if (v === 'dev' || v === 'developer' || v === 'development') return 'dev';
  if (v === 'stack') return 'stack';
  return 'generic';
}

import { bold, cyan, dim, green, yellow } from '../ui/ansi.mjs';

export function printAuthLoginInstructions({
  stackName,
  context = 'generic',
  webappUrl,
  webappUrlSource,
  internalServerUrl,
  publicServerUrl,
  rerunCmd,
}) {
  const ctx = normalizeAuthLoginContext(context);
  const subtitle =
    ctx === 'selfhost'
      ? 'Self-host'
      : ctx === 'dev'
        ? 'Dev'
        : ctx === 'stack'
          ? `Stack: ${stackName || 'unknown'}`
          : '';

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold(`${cyan('Happy')} login`));
  if (subtitle) {
    // eslint-disable-next-line no-console
    console.log(dim(subtitle));
  }
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold('What will happen:'));
  // eslint-disable-next-line no-console
  console.log(`- ${cyan('browser')}: we’ll open the Happy web app`);
  // eslint-disable-next-line no-console
  console.log(`- ${cyan('account')}: you’ll sign in (or create an account)`);
  // eslint-disable-next-line no-console
  console.log(`- ${cyan('connect')}: you’ll approve this terminal/machine connection`);
  // eslint-disable-next-line no-console
  console.log(`- ${cyan('finish')}: the CLI will complete automatically`);

  if (webappUrl) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`${dim('Web app:')}   ${cyan(webappUrl)}${webappUrlSource ? dim(` (${webappUrlSource})`) : ''}`);
  }
  if (internalServerUrl) {
    // eslint-disable-next-line no-console
    console.log(`${dim('Internal:')}  ${internalServerUrl}`);
  }
  if (publicServerUrl) {
    // eslint-disable-next-line no-console
    console.log(`${dim('Public:')}    ${publicServerUrl}`);
  }

  if (ctx === 'selfhost') {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(dim('Why this matters: login lets the daemon register this machine and enables sync across devices.'));
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold('Tips:'));
  // eslint-disable-next-line no-console
  console.log(`- If the page does not load, make sure the stack is running and reachable.`);
  // eslint-disable-next-line no-console
  console.log(`- If you see a blank page, wait for the first build (Expo/Metro) to finish.`);
  // eslint-disable-next-line no-console
  console.log(`- Re-run anytime: ${yellow(rerunCmd || 'happys auth login')}`);
  // eslint-disable-next-line no-console
  console.log(`${green('✓')} You can safely close the browser when it finishes.`);
}

