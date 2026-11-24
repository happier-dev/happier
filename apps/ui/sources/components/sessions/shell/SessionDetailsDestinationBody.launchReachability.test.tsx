import { it } from 'vitest';

import { installSessionLaunchReachabilityTest } from './sessionLaunchReachabilityTestHarness';

const expectReleaseWithPendingRead = installSessionLaunchReachabilityTest('sessionDetails');
const { SessionDetailsDestinationBody } = await import('./SessionDetailsDestinationBody');

it('reveals the cold Details loading card when the active Home becomes unreachable before headers', async () => {
    await expectReleaseWithPendingRead(SessionDetailsDestinationBody);
});
