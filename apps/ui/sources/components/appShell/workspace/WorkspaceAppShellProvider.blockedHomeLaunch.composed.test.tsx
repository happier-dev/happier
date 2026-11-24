/** @vitest-environment jsdom */
import { it } from 'vitest';

import { expectColdHomeLaunch } from './coldHomeLaunchTestHarness';

it('reveals the recovery card when the cold Home launch first fails to reach its Home', async () => {
    await expectColdHomeLaunch('home');
});
