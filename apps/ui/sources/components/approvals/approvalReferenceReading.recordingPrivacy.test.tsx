import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storage');
const { useApprovalReferenceReading } = await import('./approvalReferenceReading');

describe('approval Session references during recording privacy', () => {
    beforeEach(async () => { standardCleanup(); await homes.reset(); });
    afterEach(() => { setScreenSharingPrivacyActive(false); standardCleanup(); });

    it('conceals destructive target identity while preserving its exact navigation address', async () => {
        const home = await homes.addHome({ name: 'Approval Home', serverUrl: 'https://private-reference.test',
            accountId: 'alice', serverIdentityId: 'srv_private_reference' });
        const id = 'private-session-identity';
        const session = buildSessionListRenderableFromSession(createSessionFixture({ id, serverId: home,
            metadata: { name: 'Private review', path: '/private/review', machineId: 'private-machine' } }));
        storage.setState({ sessionListRowsByServerId: { [home]: { [id]: session } } });
        storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [home]: ['private'] } });
        storage.getState().setSessionTagAssignmentsOptimistic(home, id, ['private']);
        const hook = await renderHook(() => useApprovalReferenceReading({ kind: 'session', id, serverId: home,
            presentation: 'destructive_target' }, id, home));
        expect(hook.getCurrent().text).toContain('Private review');
        expect(hook.getCurrent().text).toContain(id.slice(-8));
        await act(async () => setScreenSharingPrivacyActive(true));
        expect(hook.getCurrent().text).not.toContain('Private review');
        expect(hook.getCurrent().text).not.toContain(id.slice(-8));
        expect(hook.getCurrent().text).not.toContain('private-machine');
        expect(hook.getCurrent().session).toEqual({ id, serverId: home });
        await act(async () => setScreenSharingPrivacyActive(false));
        expect(hook.getCurrent().text).toContain('Private review');
    });
});
