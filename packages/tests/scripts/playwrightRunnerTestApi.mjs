import { realpathSync } from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';

// The checkout's dependencies may refresh between the runner and a replacement
// worker. Playwright's test registration state belongs to the executing copy.
/** @returns {typeof import('@playwright/test')} */
export function playwrightRunnerTestApi() {
  const entry = realpathSync(process.argv[1]);
  const manifest = findPackageJSON('playwright', entry);
  if (!manifest) throw new Error('Could not locate the running Playwright installation');
  return createRequire(entry)(join(dirname(manifest), 'test.js'));
}
