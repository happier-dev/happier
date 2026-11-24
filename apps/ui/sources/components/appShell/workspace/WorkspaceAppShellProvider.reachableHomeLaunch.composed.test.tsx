/** @vitest-environment jsdom */
import { it } from 'vitest';

import { expectColdHomeLaunch } from './coldHomeLaunchTestHarness';

it('admits a cold reachable Home without showing Retry', async () => {
    await expectColdHomeLaunch('home', 'reachable');
});
