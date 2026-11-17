import { resolve } from 'node:path';

import { repoRootDir } from '../paths';
import { prepareServerSharedDepsForRun } from '../process/serverLight';

/** Playwright UI E2E: build the server's shared workspace dependencies once per run, not per spec. */
export default async function globalSetupUiE2e(): Promise<void> {
  const logsRoot = process.env.HAPPIER_E2E_LOGS_DIR?.trim();
  await prepareServerSharedDepsForRun({
    testDir: logsRoot
      ? resolve(logsRoot, 'playwright-global-setup', 'ui-e2e')
      : resolve(repoRootDir(), '.project', 'tmp', 'playwright-global-setup', 'ui-e2e'),
    env: process.env,
  });
}
