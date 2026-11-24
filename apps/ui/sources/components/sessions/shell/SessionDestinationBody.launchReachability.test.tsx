import { it } from 'vitest';

import { installSessionLaunchReachabilityTest } from './sessionLaunchReachabilityTestHarness';

const expectReleaseWithPendingRead = installSessionLaunchReachabilityTest('session');
const { SessionDestinationBody } = await import('./SessionDestinationBody');

it('reveals the cold Session loading card when the active Home becomes unreachable before headers', async () => {
    await expectReleaseWithPendingRead(SessionDestinationBody);
});
