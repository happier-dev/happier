/** @vitest-environment jsdom */
import { it } from 'vitest';

import { expectColdHomeLaunch } from './coldHomeLaunchTestHarness';

it('keeps the cold Account loading while a reachable Home is slow to admit', async () => {
    await expectColdHomeLaunch('home', 'slow');
});
