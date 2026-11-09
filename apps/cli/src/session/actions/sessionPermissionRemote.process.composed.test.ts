import { describe, it } from 'vitest';
import { runSeparateProcessPermissionMediationJourney } from './sessionPermissionRemote.composed.testkit';

describe('daemon plugin mediation to a separate Session process', () => {
    it('recovers, lists and settles through Account RPC while refusing another Account', async () => {
        await runSeparateProcessPermissionMediationJourney();
    }, 0);
});
