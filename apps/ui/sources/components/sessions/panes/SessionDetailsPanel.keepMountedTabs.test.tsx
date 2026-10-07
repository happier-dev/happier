import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionSystemRecordStoredSchema, type SessionSystemRecordStored } from '@happier-dev/protocol';
import type { MountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { createSessionFileDetailsTab, createSessionScmReviewDetailsTab, createSessionBoardDetailsTab } from './details/sessionDetailsTabBuilders';

installSessionDetailsPanelCommonModuleMocks();

type PaneRuntime = ReturnType<typeof installSessionPaneRuntimeTestHarness>;

async function mountPanel(runtime: PaneRuntime) {
    const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
    return await renderScreen(<runtime.Wrapper>
        <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
    </runtime.Wrapper>);
}

describe('SessionDetailsPanel (keep mounted tabs)', () => {
    const runtime = installSessionPaneRuntimeTestHarness();

    it('shows pending details until the deep-linked Session hydrates', async () => {
        storage.setState({ sessions: {} });
        const screen = await mountPanel(runtime);
        await act(async () => runtime.pane.openDetailsTab(createSessionFileDetailsTab('a.txt'), { intent: 'pinned' }));
        expect(screen.findHostByTestId('details-surface-fallback-pending')).not.toBeNull();
        expect(screen.findHostByTestId('details-surface-fallback-unsupported')).toBeNull();
        await act(async () => storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: runtime.serverId })]));
        expect(screen.findHostByTestId('details-surface-fallback-pending')).toBeNull();
    });

    it('retains inactive file and review views without hiding their web DOM state', async () => {
        const { SessionFileDetailsView } = await import('@/components/sessions/files/views/SessionFileDetailsView');
        const { SessionScmReviewDetailsView } = await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
        const screen = await mountPanel(runtime);
        await act(async () => runtime.pane.openDetailsTab(createSessionFileDetailsTab('a.txt'), { intent: 'pinned' }));
        await act(async () => runtime.pane.openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' }));
        expect(screen.tree.findAllByType(SessionFileDetailsView)).toHaveLength(1);
        expect(screen.tree.findAllByType(SessionScmReviewDetailsView)).toHaveLength(1);
        const inactive = screen.tree.findAll(node => typeof node.type === 'string'
            && node.props.role === 'tabpanel' && node.props.pointerEvents === 'none');
        expect(inactive).toHaveLength(1);
        expect(inactive[0].props.style).toMatchObject({ display: 'flex', visibility: 'hidden' });
        expect(inactive[0].props.accessibilityElementsHidden).toBeUndefined();
        expect(inactive[0].props.importantForAccessibility).toBeUndefined();
        await act(async () => runtime.pane.setActiveDetailsTab('file:a.txt'));
        expect(screen.tree.findAllByType(SessionFileDetailsView)).toHaveLength(1);
        expect(screen.tree.findAllByType(SessionScmReviewDetailsView)).toHaveLength(1);
        expect(runtime.pane.scopeState?.details.activeTabKey).toBe('file:a.txt');
    });

    it('publishes pin/unpin affordances that change real tab state and retain the file icon', async () => {
        const screen = await mountPanel(runtime);
        await act(async () => runtime.pane.openDetailsTab(createSessionFileDetailsTab('a.txt'), { intent: 'preview' }));
        const pin = screen.findHostByTestId('session-details-tab-pin-file_a.txt');
        expect(pin?.props.accessibilityLabel).toContain('Pin');
        await screen.pressByTestIdAsync('session-details-tab-pin-file_a.txt');
        expect(runtime.pane.scopeState?.details.tabs.find(tab => tab.key === 'file:a.txt')).toMatchObject({ isPinned: true, isPreview: false });
        const unpin = screen.findHostByTestId('session-details-tab-unpin-file_a.txt');
        expect(unpin?.props.accessibilityLabel).toContain('Unpin');
        expect(screen.findHostByTestId('session-details-tab-file-icon-file_a.txt')).not.toBeNull();
        await screen.pressByTestIdAsync('session-details-tab-unpin-file_a.txt');
        expect(runtime.pane.scopeState?.details.tabs.find(tab => tab.key === 'file:a.txt')?.isPinned).toBe(false);
    });

    it('toggles the actual right pane from the Details header in both directions', async () => {
        const screen = await mountPanel(runtime);
        await act(async () => runtime.pane.openDetailsTab(createSessionFileDetailsTab('a.txt'), { intent: 'pinned' }));
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        await screen.pressByTestIdAsync('session-details-right-pane-toggle');
        expect(runtime.pane.scopeState?.right.isOpen).toBe(true);
        await screen.pressByTestIdAsync('session-details-right-pane-toggle');
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
    });
});

function record(localId: string, kind: string, value: unknown): SessionSystemRecordStored {
    return SessionSystemRecordStoredSchema.parse({
        id: localId, address: { owner: 'host', namespace: 'surface', kind, localId },
        content: { t: 'plain', v: value }, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
}

function sessionWire(id: string) {
    const session = createSessionFixture({ id });
    return {
        id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify(session.metadata), agentState: null,
        agentStateVersion: 1, share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            audienceContext: null, capabilities: session.access!.capabilities },
    };
}

describe.each([true, false])('SessionDetailsPanel exact-Home Board action (Home enabled: %s)', (enabled) => {
    let records: SessionSystemRecordStored[] = [];
    let mounted: MountedSessionBoardController | null = null;
    const runtime = installSessionPaneRuntimeTestHarness({
        features: () => createRootLayoutFeaturesResponse({ features: { sessions: { board: { enabled } } } }),
        request: async (url) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/system-records')) return Response.json({ records, nextCursor: null, hasNext: false });
            if (path === '/v2/sessions/s1' || path === '/v2/sessions/s2') return Response.json({ session: sessionWire(path.split('/').at(-1)!) });
            if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [sessionWire('s1'), sessionWire('s2')], nextCursor: null, hasNext: false });
            if (path === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
            return null;
        },
    });

    it('requires the exact Home bit even when the Board has content or a visible split destination', async () => {
        records = [];
        mounted = null;
        storage.getState().applySettingsLocal({ experiments: true });
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionBoardControllerProvider, useMountedSessionBoardController } = await import('@/components/sessions/board/SessionBoardControllerProvider');
        function Probe() {
            mounted = useMountedSessionBoardController({ serverId: runtime.serverId, sessionId: 's1' });
            return null;
        }
        const readMounted = () => mounted;
        function Panel({ providerSessionId = 's1' }: Readonly<{ providerSessionId?: string }>) {
            return <runtime.Wrapper><SessionBoardControllerProvider sessionId={providerSessionId} serverId={runtime.serverId}>
                <Probe /><SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
            </SessionBoardControllerProvider></runtime.Wrapper>;
        }
        const screen = await renderScreen(<Panel />);
        await act(async () => runtime.pane.openDetailsTab(createSessionFileDetailsTab('a.txt'), { intent: 'pinned' }));
        await flushHookEffects({ cycles: 30 });
        expect(screen.findHostByTestId('session-details-open-board')).toBeNull();
        records = [
            record('layout', 'layout.v1', { v: 1, tabs: [{ id: 'research', title: 'Research', items: [{ itemId: 'item-1', width: 'medium' }] }] }),
            record('item-1', 'item.v1', { v: 1, title: 'Status', frame: 'card',
                height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'widget', instance: { v: 1, id: 'instance-1',
                    definition: { kind: 'installed', surface: { pluginId: 'acme.board', localId: 'status' } }, bindings: {} } } }),
        ];
        await act(async () => readMounted()?.binding.refresh?.());
        await flushHookEffects({ cycles: 30 });
        const binding = readMounted()?.binding;
        if (enabled) {
            expect(binding?.status).toBe('ready');
            if (binding?.status !== 'ready') throw new Error('Expected current Board records');
            expect(binding.snapshot.itemsById.size).toBe(1);
            expect(screen.findHostByTestId('session-details-open-board')).not.toBeNull();
            records = [];
            await act(async () => readMounted()?.binding.refresh?.());
            await flushHookEffects({ cycles: 30 });
            const empty = readMounted()?.binding;
            expect(empty?.status).toBe('ready');
            if (empty?.status !== 'ready') throw new Error('Expected empty current Board records');
            expect(empty.snapshot.itemsById.size).toBe(0);
            expect(screen.findHostByTestId('session-details-open-board')).toBeNull();
        } else {
            expect(binding).toMatchObject({ status: 'unavailable', reason: 'board_feature_disabled' });
            expect(screen.findHostByTestId('session-details-open-board')).toBeNull();
        }
        await act(async () => {
            runtime.pane.splitDetailsGroup?.({ axis: 'horizontal' });
            runtime.pane.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' });
        });
        expect(runtime.pane.scopeState?.details.groups?.some(group => group.activeTabKey === 'board')).toBe(true);
        expect(Boolean(screen.findHostByTestId('session-details-open-board'))).toBe(enabled);
        if (enabled) {
            await act(async () => runtime.pane.closeDetailsTab('board'));
            storage.getState().applySessions([createSessionFixture({ id: 's2', serverId: runtime.serverId })]);
            records = [record('item-1', 'item.v1', { v: 1, title: 'Other Session card', frame: 'card',
                height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'widget', instance: { v: 1, id: 'other',
                    definition: { kind: 'installed', surface: { pluginId: 'acme.board', localId: 'status' } }, bindings: {} } } })];
            await act(async () => screen.tree.update(<Panel providerSessionId="s2" />));
            await flushHookEffects({ cycles: 30 });
            expect(readMounted()).toBeNull();
            expect(screen.findHostByTestId('session-details-open-board')).toBeNull();
        }
    });
});
