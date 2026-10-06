import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import type { SessionCompanionAddBinding } from './picker/SessionCompanionAddControl';
import type { SessionCompanionInstanceControls } from './SessionCompanionItemFrame';

installSettingsViewCommonModuleMocks({ storage: importOriginal => importOriginal() });
installDisconnectedServerSocketBoundary();

const { storage } = await import('@/sync/domains/state/storageStore');
const { SessionCompanionContent } = await import('./SessionCompanionContent');
const { SessionCompanionAddControl } = await import('./picker/SessionCompanionAddControl');
const { useSessionCompanionController } = await import('./state/useSessionCompanionController');
const { buildCompanionWidgetAddSections } = await import('@/components/widgets/add/widgetAddSections');
const initial = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreGlobals: (() => void) | undefined;
let restoreSyncLoader: (() => void) | undefined;

afterEach(async () => {
    standardCleanup();
    restoreGlobals?.();
    await connection?.dispose();
    restoreSyncLoader?.();
    connection = undefined;
    storage.setState({ profileScope: initial.profileScope, settings: initial.settings, localSettings: initial.localSettings });
});

describe('Companion widget write acknowledgement', () => {
    it.each(['setup', 'inputs', 'rename'] as const)('keeps %s unsaved when the actual local preference owner loses its realm', async operation => {
        restoreGlobals = withPopoverWebGlobals();
        const boundary = createHomeHubArtifactHttpBoundary('account-a');
        await import('@/sync/syncEngine');
        const syncLoader = await loadVitestModuleForNodeRequire(new URL('../../../sync/sync.ts', import.meta.url), () => import('@/sync/sync'));
        restoreSyncLoader = syncLoader.dispose;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://companion-write.test', accountId: 'account-a', request: boundary.request });
        const serverId = connection.home.id;
        storage.setState({ isDataReady: true, profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
        const session = createSessionFixture({ id: 'session-1', serverId });
        const openFullSurface = () => {};
        let companion: ReturnType<typeof useSessionCompanionController> | undefined;
        function Probe() {
            const controller = useSessionCompanionController({ sessionId: session.id, serverId, openFullSurface });
            companion = controller;
            return <SessionCompanionContent session={session} serverId={serverId} controller={controller}
                boardBinding={null} resolvePrimaryHost={() => 'companion'} onRevealBoardItem={() => {}}
                addBinding={{ pluginProjection: null }} />;
        }
        const screen = await renderScreen(<Probe />);
        await flushHookEffects({ cycles: 3 });
        const binding: SessionCompanionAddBinding = screen.root.findByType(SessionCompanionAddControl).props.binding;
        const candidate = { key: 'builtin:agent_plan', definition: { kind: 'builtin' as const, id: 'agent_plan' as const }, title: 'Plan', pluginName: 'Happier', sharedPluginName: false, icon: 'list-checks' as const, homeDefault: 'available' as const, target: 'session' as const,
            inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json' as const, required: true }] } };
        const setup = buildCompanionWidgetAddSections({ ...binding, glanceCandidates: [candidate] })[0]!.entries[0]!.setup!();
        const draft = { bindings: { session: { kind: 'value' as const, value: { serverId, sessionId: session.id } } } };
        if (operation !== 'setup') {
            await act(async () => { companion!.addItem({ kind: 'instance', instance: { v: 1, id: 'existing', definition: candidate.definition, bindings: draft.bindings } }); });
            await flushHookEffects({ cycles: 3 });
            expect(companion!.preference.items).toMatchObject([{ kind: 'instance', instance: { id: 'existing' } }]);
            const controls: SessionCompanionInstanceControls = screen.root.findAll(node => node.props.instanceControls?.instance.id === 'existing')[0]!.props.instanceControls;
            await expect(controls.setInputs(draft.bindings)).resolves.toEqual({ ok: true });
            const before = storage.getState().localSettings.sessionCompanionPreferencesBySessionV1;
            await act(async () => { storage.setState({ profileScope: null }); });
            if (operation === 'inputs') {
                const changed = { session: { kind: 'value' as const, value: { serverId, sessionId: 'session-2' } } };
                await expect(controls.setInputs(changed)).resolves.toEqual({ ok: false, message: 'widgetAdd.saveFailed' });
            } else {
                await expect(controls.rename('My plan')).rejects.toThrow('session_companion_write_refused');
            }
            expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1).toBe(before);
            return;
        }
        // Keep the real callback from the open step while the canonical storage authority retires.
        await act(async () => { storage.setState({ profileScope: null }); });
        await expect(setup.submit(draft)).resolves.toEqual({ ok: false, message: 'widgetAdd.addFailed' });
        expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1).toEqual(initial.localSettings.sessionCompanionPreferencesBySessionV1);
    });
});
