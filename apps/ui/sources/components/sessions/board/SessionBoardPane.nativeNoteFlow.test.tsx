import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readSessionSurfaceNoteTextV1,
    type SessionBoardItemUpsertInputV1,
    type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import {
    projectSessionBoard,
    type SessionBoardActionsPort,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';

import { SessionBoardContinuityProvider } from './SessionBoardContinuity';
import { SessionBoardControllerOwner } from './SessionBoardControllerProvider';
import { SessionBoardPane } from './SessionBoardPane';
import { createSessionBoardSourceAvailabilityResolver } from './sessionBoardItemPresentation';

const editorHarness = vi.hoisted(() => ({
    value: '',
    flushPendingChange: vi.fn(async () => undefined),
}));

// SessionBoardPane also imports the sibling hosted-HTML editor. Keep its
// bundler-selected editor boundary out of this mounted native-Note suite; the
// Board/controller/Note owners below remain real.
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));

vi.mock('@/components/ui/markdown/editor/MarkdownCodeEditorField', () => ({
    MarkdownCodeEditorField: (props: Readonly<{
        editorRef?: { current: unknown };
        testID?: string;
    }>) => {
        if (props.editorRef) {
            props.editorRef.current = {
                flushPendingChange: editorHarness.flushPendingChange,
                getValue: () => editorHarness.value,
                focus: () => undefined,
            };
        }
        return React.createElement('MarkdownCodeEditorField', props);
    },
}));

vi.mock('@react-navigation/native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(),
    useNavigation: () => ({ dispatch: () => undefined }),
    usePreventRemove: () => undefined,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock().module;
});

const EMPTY_SNAPSHOT = projectSessionBoard({
    layout: undefined,
    items: new Map(),
    capabilities: { readTranscript: true, editSessionRecords: true },
    freshness: 'fresh',
    reachability: 'reachable',
    loading: 'idle',
    incomplete: false,
});

const PLUGIN_RUNTIME = Object.freeze({
    pluginUiProjection: null,
    pluginBrowserProjection: null,
    phase: 'unavailable' as const,
    interactionEnabled: false,
    machineId: null,
    serverId: 'home-1',
    platform: 'web' as const,
});

function populatedSnapshot(input: SessionBoardItemUpsertInputV1): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: {
            revision: 'layout-revision-1',
            outcome: {
                status: 'ready',
                value: {
                    v: 1,
                    tabs: [{
                        id: input.placement!.tabId!,
                        title: input.placement!.tabTitle!,
                        items: [{ itemId: input.itemId, width: input.placement!.width! }],
                    }],
                },
            },
        },
        items: new Map([[input.itemId, {
            revision: 'item-revision-1',
            outcome: { status: 'ready' as const, value: input.item },
        }]]),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    });
}

const HOSTED_HTML_ITEM: SessionSurfaceItemV1 = {
    v: 1,
    title: 'Build dashboard',
    frame: 'card',
    height: { mode: 'auto', fallback: 'regular' },
    source: {
        kind: 'hostedHtml',
        source: { kind: 'html', html: '<main>Build status</main>' },
        requestedCapabilities: { hostMethods: [], actions: [], networkOrigins: [] },
    },
};

const HOSTED_HTML_SNAPSHOT = projectSessionBoard({
    layout: {
        revision: 'layout-revision-1',
        outcome: {
            status: 'ready',
            value: {
                v: 1,
                tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'html-1', width: 'medium' }] }],
            },
        },
    },
    items: new Map([['html-1', {
        revision: 'html-revision-1',
        outcome: { status: 'ready' as const, value: HOSTED_HTML_ITEM },
    }]]),
    capabilities: { readTranscript: true, editSessionRecords: true },
    freshness: 'fresh',
    reachability: 'reachable',
    loading: 'idle',
    incomplete: false,
});

function hostedHtmlRuntime(): CallerHostedHtmlRuntime {
    return {
        serverIdentityId: 'server-identity-1',
        accountId: 'account-1',
        hostOrigin: 'https://app.example.com',
        admittedHostMethods: [],
        isApproved: () => true,
        approve: () => undefined,
        revoke: () => undefined,
        createRequestController: () => ({
            handleRequest: async () => null,
            dispose: () => undefined,
        }),
        lifetime: {
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        },
    };
}

function itemActionIds(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    itemId: string,
): readonly string[] {
    const owner = screen.tree.root.findAll(
        (node) => (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID
            === `session-board-item-${itemId}-actions`,
        { deep: true },
    ).at(-1);
    return ((owner?.props as { actions?: ReadonlyArray<{ id: string }> } | undefined)?.actions ?? [])
        .map((action) => action.id);
}

describe('SessionBoardPane native Note flow', () => {
    afterEach(() => standardCleanup());

    it('creates and rereads a blank-Board Note through the mounted Action port without losing the final editor value', async () => {
        const upsertItem = vi.fn(async (input: SessionBoardItemUpsertInputV1) => ({
            status: 'ok' as const,
            value: {
                v: 1 as const,
                serverId: 'home-1',
                sessionId: 'session-1',
                result: {
                    operation: 'upsert_item' as const,
                    outcome: 'created' as const,
                    itemId: input.itemId,
                    itemRevision: 'item-revision-1',
                    layoutRevision: 'layout-revision-1',
                },
                destination: { tabId: 'overview', width: 'medium' as const },
            },
        }));
        const actions: SessionBoardActionsPort = {
            upsertItem,
            removeItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
            updateLayout: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
        };
        const renderMountedPane = (snapshot: SessionBoardSnapshot) => {
            const binding = { status: 'ready' as const, snapshot, refresh: () => undefined };
            return (
                <SessionBoardContinuityProvider sessionId="session-1" serverId="home-1">
                    <SessionBoardControllerOwner
                        address={{ serverId: 'home-1', sessionId: 'session-1' }}
                        input={{ sessionId: 'session-1', serverId: 'home-1', binding, actions }}
                        binding={binding}
                        actions={actions}
                        pluginRuntime={PLUGIN_RUNTIME}
                        callerHostedHtmlRuntime={null}
                    >
                        <SessionBoardPane
                            sessionId="session-1"
                            serverId="home-1"
                            host="details"
                            resolvePrimaryHost={() => 'details'}
                            density="full"
                            layout="grid"
                        />
                    </SessionBoardControllerOwner>
                </SessionBoardContinuityProvider>
            );
        };

        const screen = await renderScreen(renderMountedPane(EMPTY_SNAPSHOT));
        expect(screen.findHostByTestId('session-board-pane-surface-empty')).not.toBeNull();

        // A blank Board leads with its own first step (Add a note); the Add popover is for a Board with content.
        await act(async () => {
            screen.pressByTestId('session-board-pane-surface-empty-action');
        });
        expect(screen.findByTestId('session-board-note-editor-title')).not.toBeNull();

        await act(async () => {
            screen.findByTestId('session-board-note-editor-title')?.props.onChangeText?.('Release note');
        });
        editorHarness.value = 'Body including the final keystroke!';
        await act(async () => {
            screen.findByTestId('session-board-note-editor-save')?.props.onPress?.();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(upsertItem).toHaveBeenCalledOnce();
        const submitted = upsertItem.mock.calls[0]?.[0];
        expect(submitted).toBeDefined();
        if (!submitted) throw new Error('Expected the mounted Note editor to submit an upsert');
        expect(submitted.placement).toEqual({
            tabId: 'overview',
            tabTitle: 'Overview',
            width: 'medium',
        });
        expect(submitted.item.source.kind).toBe('declarative');
        expect(submitted.item.source.kind === 'declarative'
            ? readSessionSurfaceNoteTextV1(submitted.item.source.document)
            : null).toBe('Body including the final keystroke!');

        await screen.update(renderMountedPane(populatedSnapshot(submitted)));

        expect(screen.findByTestId('session-board-note-editor-title')).toBeNull();
        expect(screen.getTextContent()).toContain('Release note');
        expect(screen.getTextContent()).toContain('Body including the final keystroke!');
        expect(screen.findByTestId('session-board-pane-surface-add-trigger')).not.toBeNull();
    });

    it('offers hosted-HTML Edit only when the mounted caller runtime can render the editor', async () => {
        const actions: SessionBoardActionsPort = {
            upsertItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
            removeItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
            updateLayout: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
        };
        const renderMountedPane = (runtime: CallerHostedHtmlRuntime | null) => {
            const binding = { status: 'ready' as const, snapshot: HOSTED_HTML_SNAPSHOT, refresh: () => undefined };
            return (
                <SessionBoardContinuityProvider sessionId="session-1" serverId="home-1">
                    <SessionBoardControllerOwner
                        address={{ serverId: 'home-1', sessionId: 'session-1' }}
                        input={{
                            sessionId: 'session-1',
                            serverId: 'home-1',
                            binding,
                            actions,
                            callerHostedHtmlAvailable: runtime !== null,
                            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver({
                                hostedHtmlRendererAvailable: runtime !== null,
                            }),
                        }}
                        binding={binding}
                        actions={actions}
                        pluginRuntime={PLUGIN_RUNTIME}
                        callerHostedHtmlRuntime={runtime}
                    >
                        <SessionBoardPane
                            sessionId="session-1"
                            serverId="home-1"
                            host="details"
                            resolvePrimaryHost={() => 'details'}
                            density="full"
                            layout="grid"
                        />
                    </SessionBoardControllerOwner>
                </SessionBoardContinuityProvider>
            );
        };

        const unavailable = await renderScreen(renderMountedPane(null));
        expect(itemActionIds(unavailable, 'html-1')).not.toContain('edit');
        expect(unavailable.findByTestId('session-board-hosted-html-editor')).toBeNull();
        expect(unavailable.findByTestId('session-board-item-html-1-state')).not.toBeNull();

        const runtime = hostedHtmlRuntime();
        const available = await renderScreen(renderMountedPane(runtime));
        const actionOwner = available.tree.root.findAll(
            (node) => (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID
                === 'session-board-item-html-1-actions',
            { deep: true },
        ).at(-1);
        const edit = ((actionOwner?.props as {
            actions?: ReadonlyArray<{ id: string; onPress: () => void }>;
        } | undefined)?.actions ?? []).find((action) => action.id === 'edit');
        expect(edit).toBeDefined();

        await act(async () => { edit?.onPress(); });
        expect(available.findByTestId('session-board-hosted-html-editor')).not.toBeNull();
    });
});
