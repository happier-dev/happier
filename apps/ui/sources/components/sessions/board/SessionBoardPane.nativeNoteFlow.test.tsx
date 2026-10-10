import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readSessionSurfaceNoteTextV1,
    SessionBoardMutationV1Schema,
    SessionSurfaceItemV1Schema,
    type SessionBoardItemUpsertInputV1,
    type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { CodeEditorHandle, CodeEditorProps } from '@/components/ui/code/editor/codeEditorTypes';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import {
    projectSessionBoard,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';

import { SessionBoardContinuityProvider } from './SessionBoardContinuity';
import { SessionBoardControllerOwner } from './SessionBoardControllerProvider';
import { SessionBoardPane } from './SessionBoardPane';
import { createSessionBoardSourceAvailabilityResolver } from './sessionBoardItemPresentation';
import { realBoardActions } from './sessionBoardActionsTestkit';
import { unavailableSessionBoardActions } from '@/sync/domains/session/board/sessionBoardActionsPort';

const editorHarness = vi.hoisted(() => ({
    value: '',
    flushPendingChange: vi.fn(async () => undefined),
}));

// CodeMirror's platform surface is the embedded-editor boundary; the Board,
// controller, Note editor and Markdown field/ref forwarding remain real.
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({
    CodeEditor: React.forwardRef<CodeEditorHandle, CodeEditorProps>(function MockCodeEditor(props, ref) {
        React.useImperativeHandle(ref, () => ({
            flushPendingChange: editorHarness.flushPendingChange,
            getValue: () => editorHarness.value,
            focus: () => undefined,
        }), []);
        return React.createElement('MockCodeEditor', props);
    }),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({ navigation: { dispatch: () => undefined } }).module;
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit');
    return createReactNavigationNativeMock();
});

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
        source: artifactHtmlBundleFromBodyV1('<main>Build status</main>'),
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
        const mutations: Array<ReturnType<typeof SessionBoardMutationV1Schema.parse>> = [];
        const actions = realBoardActions(async (_path, init) => {
            if (init?.method !== 'PUT') return Response.json({ record: null });
            const mutation = SessionBoardMutationV1Schema.parse(JSON.parse(String(init.body)));
            mutations.push(mutation);
            if (mutation.operation !== 'upsert_item') throw new Error('Expected a Note upsert');
            const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
            return Response.json({ operation: 'upsert_item', outcome: 'created', itemId: mutation.itemId, itemRevision: revision, layoutRevision: revision });
        }, undefined, { serverId: 'home-1', sessionId: 'session-1' });
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

        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findByTestId('session-board-note-editor-title')).toBeNull();
        });
        expect(mutations).toHaveLength(1);
        const mutation = mutations[0];
        if (mutation?.operation !== 'upsert_item' || mutation.itemContent.t !== 'plain') {
            throw new Error('Expected the mounted Note editor to persist a plain upsert');
        }
        expect(mutation.placement?.layoutContent).toMatchObject({ t: 'plain', v: { tabs: [{
            id: 'overview', title: 'Overview', items: [{ itemId: mutation.itemId, width: 'medium' }],
        }] } });
        const submitted: SessionBoardItemUpsertInputV1 = {
            sessionId: 'session-1', itemId: mutation.itemId, expectedItemRevision: null,
            item: SessionSurfaceItemV1Schema.parse(mutation.itemContent.v),
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
        };
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
        const actions = unavailableSessionBoardActions;
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
