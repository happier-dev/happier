import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

/**
 * The pane is a placement, not an owner.
 *
 * Recovery navigation for a locked record or a retired plugin now lives with the
 * mounted controller, which holds the exact Session Home — see
 * `SessionBoardControllerProvider.recovery.test.tsx`. What remains pane-owned is
 * the host-local Action binding it opens for its own placement.
 */

const harness = vi.hoisted(() => ({
    surfaceProps: null as null | Readonly<Record<string, unknown>>,
    hostActionInput: null as null | Readonly<Record<string, unknown>>,
    canEdit: true,
    reachability: 'reachable' as 'reachable' | 'offline',
    companionAvailable: true,
    revealPortAvailable: true,
    revealPortAddress: { serverId: 'home-1', sessionId: 'session-1' },
    companionShow: vi.fn(),
    revealAfterMutation: vi.fn(),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('./SessionBoardControllerProvider', () => ({
    useMountedSessionBoardController: () => ({
        address: { serverId: 'home-1', sessionId: 'session-1' },
        actions: {},
        binding: {
            status: 'ready',
            refresh: vi.fn(),
            snapshot: {
                itemsById: new Map([['item-1', {
                    revision: 'revision-1',
                    state: {
                        kind: 'ready',
                        item: {
                            itemId: 'item-1',
                            source: { kind: 'widget', instance: { v: 1, id: 'instance-1', definition: { kind: 'installed', surface: { pluginId: 'acme.board', localId: 'status' } }, bindings: {} } },
                        },
                    },
                }]]),
                loading: 'idle', freshness: 'fresh', incomplete: false,
                reachability: harness.reachability, canEdit: harness.canEdit,
            },
        },
        controller: { noteDraft: null, hostedHtmlDraft: null },
        pluginRuntime: null,
        callerHostedHtmlRuntime: null,
    }),
}));
vi.mock('./useSessionBoardHostActionBindings', () => ({
    useSessionBoardHostActionBindings: (input: Readonly<Record<string, unknown>>) => {
        harness.hostActionInput = input;
        return undefined;
    },
}));
vi.mock('./SessionBoardSurface', () => ({
    SessionBoardSurface: (props: Readonly<Record<string, unknown>>) => {
        harness.surfaceProps = props;
        return React.createElement('SessionBoardSurface', props);
    },
}));
vi.mock('@/components/sessions/companion/state/useSessionCompanionController', () => ({
    useSessionCompanionController: () => ({
        preference: { items: [] },
        availability: harness.companionAvailable ? 'ready' : 'realm_unavailable',
        show: harness.companionShow,
        removeItem: vi.fn(),
    }),
}));
vi.mock('@/components/sessions/companion/presentation/SessionCompanionRevealPort', () => ({
    useSessionCompanionRevealPort: (address: Readonly<{ serverId: string; sessionId: string }> | null) => harness.revealPortAvailable
        && address?.serverId === harness.revealPortAddress.serverId
        && address.sessionId === harness.revealPortAddress.sessionId ? {
        address: harness.revealPortAddress,
        openFullSurface: vi.fn(),
        revealAfterMutation: harness.revealAfterMutation,
        revealBoardItem: vi.fn(),
    } : null,
}));
vi.mock('@/components/sessions/presentation/presentationNotices', () => ({ publishPresentationNotice: vi.fn() }));
// The editor wrapper selects its platform module through a bundler-only require.
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));

import { SessionBoardPane } from './SessionBoardPane';

describe('SessionBoardPane placement composition', () => {
    beforeEach(() => {
        standardCleanup();
        harness.surfaceProps = null;
        harness.hostActionInput = null;
        harness.canEdit = true;
        harness.reachability = 'reachable';
        harness.companionAvailable = true;
        harness.revealPortAvailable = true;
        harness.revealPortAddress = { serverId: 'home-1', sessionId: 'session-1' };
        harness.companionShow.mockReset();
        harness.revealAfterMutation.mockReset();
        harness.companionShow.mockReturnValue({
            previous: { v: 1, visible: false, collapsed: false, edge: 'trailing', density: 'comfortable', items: [] },
            applied: {
                v: 1,
                visible: true,
                collapsed: false,
                edge: 'trailing',
                density: 'comfortable',
                items: [{ kind: 'widget', widgetId: 'item-1' }],
            },
        });
    });

    it('leaves declarative Action admission to the canonical Action front door for a readable reachable Board', async () => {
        harness.canEdit = false;
        await renderScreen(
            <SessionBoardPane
                sessionId="session-1"
                serverId="home-1"
                host="details"
                resolvePrimaryHost={() => 'details'}
                density="full"
                layout="grid"
            />,
        );

        expect(harness.hostActionInput).toEqual(expect.objectContaining({
            serverId: 'home-1',
            sessionId: 'session-1',
            enabled: true,
        }));
    });

    it('does not re-derive recovery navigation the mounted controller already owns', async () => {
        await renderScreen(
            <SessionBoardPane
                sessionId="session-1"
                serverId="home-1"
                host="details"
                resolvePrimaryHost={() => 'details'}
                density="full"
                layout="grid"
            />,
        );

        expect(harness.surfaceProps).not.toHaveProperty('onManagePlugin');
        expect(harness.surfaceProps).not.toHaveProperty('onPrepareEncryption');
    });

    it.each([
        ['details', undefined],
        ['focusedDetails', undefined],
        ['sidebar', 'navigation'],
        ['mobileCockpit', undefined],
    ] as const)('adds from the %s host through the exact reveal port and reveals only after the local mutation applies', async (host, interaction) => {
        await renderScreen(
            <SessionBoardPane
                sessionId="session-1"
                serverId="home-1"
                host={host}
                resolvePrimaryHost={() => host}
                density="full"
                layout="grid"
                {...(interaction ? { interaction } : {})}
            />,
        );

        const add = harness.surfaceProps?.onAddToCompanion as ((itemId: string) => void) | undefined;
        expect(add).toBeDefined();
        add?.('item-1');
        expect(harness.companionShow).toHaveBeenCalledWith({ kind: 'widget', widgetId: 'item-1' });
        expect(harness.revealAfterMutation).toHaveBeenCalledWith(expect.objectContaining({
            applied: expect.objectContaining({ items: [{ kind: 'widget', widgetId: 'item-1' }] }),
        }));
    });

    it.each([
        ['another or absent exact presentation realm', () => { harness.revealPortAvailable = false; }],
        ['a reveal port for the same Session id on another Home', () => {
            harness.revealPortAddress = { serverId: 'home-2', sessionId: 'session-1' };
        }],
        ['an unavailable Companion preference realm', () => { harness.companionAvailable = false; }],
        ['an unreachable Board Home', () => { harness.reachability = 'offline'; }],
    ])('does not advertise Add to Companion for %s', async (_label, arrange) => {
        arrange();
        await renderScreen(
            <SessionBoardPane
                sessionId="session-1"
                serverId="home-1"
                host="sidebar"
                resolvePrimaryHost={() => null}
                density="compact"
                layout="single"
                interaction="navigation"
            />,
        );

        expect(harness.surfaceProps).not.toHaveProperty('onAddToCompanion');
    });

    it('does not reveal when the local preference mutation is unchanged', async () => {
        harness.companionShow.mockReturnValue(null);
        await renderScreen(
            <SessionBoardPane
                sessionId="session-1"
                serverId="home-1"
                host="focusedDetails"
                resolvePrimaryHost={() => 'focusedDetails'}
                density="full"
                layout="grid"
            />,
        );

        const add = harness.surfaceProps?.onAddToCompanion as ((itemId: string) => void) | undefined;
        add?.('item-1');
        expect(harness.revealAfterMutation).not.toHaveBeenCalled();
    });
});
