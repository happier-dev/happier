import { prompt, withRl } from '../cli/wizard.mjs';
import { openUrlInBrowser } from '../ui/browser.mjs';
import { preferStackLocalhostUrl } from '../paths/localhost_host.mjs';
import { bold, cyan, dim, green, yellow } from '../ui/ansi.mjs';

export async function guidedStackWebSignupThenLogin({ webappUrl, stackName }) {
  const url = await preferStackLocalhostUrl(webappUrl, { stackName });

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold(`${cyan('Happy')} login`));

  // Step 1/2
  // eslint-disable-next-line no-console
  console.log(dim('Step 1/2 — open the web app'));
  // eslint-disable-next-line no-console
  console.log(`We’ll open the Happy web app so you can ${bold('create an account')} (or ${bold('log in')}).`);
  if (url) {
    // eslint-disable-next-line no-console
    console.log(`${dim('URL:')} ${cyan(url)}`);
  }
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(`${bold('Press Enter')} to open it in your browser.`);
  await withRl(async (rl) => {
    await prompt(rl, '', { defaultValue: '' });
  });
  if (url) {
    await openUrlInBrowser(url);
  }
  // eslint-disable-next-line no-console
  console.log(`${green('✓')} Browser opened`);

  // Step 2/2
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(dim('Step 2/2 — connect this terminal'));
  // eslint-disable-next-line no-console
  console.log(`Next, we’ll connect ${bold('this terminal')} to your Happy account.`);
  // eslint-disable-next-line no-console
  console.log(`When prompted, choose: ${bold('Web Browser')} ${dim('(press 2)')}.`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(`After you’ve created/logged in in the browser, ${bold('press Enter')} to continue.`);
  // eslint-disable-next-line no-console
  console.log(dim(`Tip: if the page is blank, wait for the first build to finish, then retry.`));
  // eslint-disable-next-line no-console
  console.log(dim(`Tip: you can always re-run later with: ${yellow(`hapsta stack auth ${stackName || 'main'} login`)}`));
  await withRl(async (rl) => {
    await prompt(rl, '', { defaultValue: '' });
  });
}

