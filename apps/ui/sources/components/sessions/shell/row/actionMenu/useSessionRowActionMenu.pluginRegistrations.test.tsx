import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginContributesV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';

import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { act, createSessionListRenderableSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
const { useSessionRowActionMenu } = await import('./useSessionRowActionMenu');
const SESSION_ID = 'session_1';
let serverId: string;
let previousState = storage.getState();

const target = Object.freeze({ artifactId: 'client-runtime', exportName: 'activate', platform: 'web' as const });
const contributes = PluginContributesV2Schema.parse({ actions: [{
    id: 'open-preview', title: 'Open preview', scopes: ['session'], surfaces: ['ui'], placementBindings: ['detailsPanel'],
    dangerLevel: 'safe', execution: { target: 'client', client: { artifactId: target.artifactId, exportName: target.exportName },
        platforms: [target.platform] } }] });

const admission = Object.freeze({
    pluginId: 'acme.preview', contributes, target, executionOrigin: null, occurrenceId: 'occurrence-1',
    hostUiApiRange: '^1.0.0', identity: { pluginId: 'acme.preview', contributionId: target.artifactId,
        artifactId: target.artifactId, artifactDigest: `sha256:${'b'.repeat(64)}` as const, platform: 'web' as const },
    moduleReference: { exportName: target.exportName }, authority: { serverId: 'server-1', machineId: 'machine-1' },
});

/** One real index commit in the installed client-executable composition: an admitted target's refusal changes. */
function publishUnrelatedRegistrationChange(code: string) {
    getInstalledPluginUiClientExecutableComposition().refuse(admission,
        { ok: false, code, layer: 'artifact', phase: 'preparation', retryable: true, diagnostics: [] });
}

async function renderRowMenu(menuOpen: boolean) {
    const rowTarget = createSessionActionTarget({
        session: createSessionListRenderableSessionFixture({
            id: SESSION_ID, active: false, owner: 'user_1', metadata: null,
            seq: 4, lastViewedSessionSeq: 4, latestTurnStatus: 'completed',
        }),
        serverId,
        currentUserId: 'user_1',
        isConnected: false,
        attentionStandingEnabled: false,
        attentionStanding: false,
    });
    const counter = { renders: 0 };
    await renderHook(() => {
        counter.renders += 1;
        return useSessionRowActionMenu({
            target: rowTarget, sessionName: 'Session one', hideInactiveSessions: false, iconColor: '#000000',
            activeTags: [], knownTags: [], tagsEnabled: false, touchPrimaryPointer: false, menuOpen,
            setContextMenuOpen: () => undefined, openTagsMenuFromContext: () => undefined,
        });
    });
    return counter;
}

beforeEach(async () => {
    previousState = storage.getState();
    await home.reset();
    serverId = await home.addHome({ name: 'Row plugin Home', serverUrl: 'https://row-plugin-registrations.test', accountId: 'user_1' });
});
afterEach(async () => {
    await getInstalledPluginUiClientExecutableComposition().unload();
    await standardCleanup();
    await home.reset();
    storage.setState(previousState, true);
});

describe('session row action menu and client-executable registrations', () => {
    it('a closed row menu does not redraw on client-executable index commits; an open one does', async () => {
        await getInstalledPluginUiClientExecutableComposition().retain([admission]);
        const closed = await renderRowMenu(false);
        const closedBefore = closed.renders;
        const revisionBefore = getInstalledPluginUiClientExecutableComposition().revision();
        for (const code of ['closed-a', 'closed-b', 'closed-c']) await act(async () => publishUnrelatedRegistrationChange(code));
        expect(getInstalledPluginUiClientExecutableComposition().revision() - revisionBefore).toBe(3);
        expect(closed.renders - closedBefore).toBe(0);

        const open = await renderRowMenu(true);
        const openBefore = open.renders;
        await act(async () => publishUnrelatedRegistrationChange('open-a'));
        expect(open.renders - openBefore).toBeGreaterThan(0);
    });
});
