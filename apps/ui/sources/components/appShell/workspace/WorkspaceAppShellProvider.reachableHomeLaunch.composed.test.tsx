/** @vitest-environment jsdom */
import { it } from 'vitest';

import { expectColdHomeLaunch } from './coldHomeLaunchTestHarness';

it('admits a cold reachable Home without showing Retry', async () => {
    await expectColdHomeLaunch('home', 'reachable');
});

it('keeps a dual-carrier Home restoring until its browser verifies the HTTP origin, then admits it', async () => {
    await expectColdHomeLaunch('home', 'dual-carrier');
});
