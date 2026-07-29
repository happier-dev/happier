import React from 'react';
import renderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { UserTextMessage } from '@/sync/domains/messages/messageTypes';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/sessions/reviews/messages/ReviewFindingsMessageCard', () => ({
    ReviewFindingsMessageCard: (props: any) => React.createElement('ReviewFindingsMessageCard', props),
}));

vi.mock('@/components/sessions/reviews/messages/ReviewFollowUpMessageCard', () => ({
    ReviewFollowUpMessageCard: (props: any) => React.createElement('ReviewFollowUpMessageCard', props),
}));

vi.mock('@/components/sessions/plans/messages/PlanOutputMessageCard', () => ({
    PlanOutputMessageCard: (props: any) => React.createElement('PlanOutputMessageCard', props),
}));

vi.mock('@/components/sessions/delegations/messages/DelegateOutputMessageCard', () => ({
    DelegateOutputMessageCard: (props: any) => React.createElement('DelegateOutputMessageCard', props),
}));

const machinePluginStructuredMessageResolveMock = vi.hoisted(() => vi.fn());
const machinePluginStructuredMessageActionExecuteMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machinePluginStructuredMessageResolve: machinePluginStructuredMessageResolveMock,
    machinePluginStructuredMessageActionExecute: machinePluginStructuredMessageActionExecuteMock,
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineControlTargetForSession: () => ({ machineId: 'machine-1' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: () => 'server-1',
}));

let StructuredMessageBlock: typeof import('./StructuredMessageBlock').StructuredMessageBlock;
const editableInteraction = deriveTranscriptInteraction({
    kind: 'session',
    accessLevel: null,
    canApprovePermissions: true,
    isSessionActive: true,
});
const publicInteraction = deriveTranscriptInteraction({ kind: 'public' });

beforeAll(async () => {
    ({ StructuredMessageBlock } = await import('./StructuredMessageBlock'));
});

beforeEach(() => {
    machinePluginStructuredMessageResolveMock.mockReset();
    machinePluginStructuredMessageActionExecuteMock.mockReset();
    machinePluginStructuredMessageActionExecuteMock.mockResolvedValue({
        supported: true,
        result: { ok: true, result: null },
    });
    machinePluginStructuredMessageResolveMock.mockImplementation(async (
        _machineId: string,
        params: Readonly<{ kind: string; payload: unknown }>,
    ) => ({
        supported: true,
        resolution: {
            ok: true,
            model: {
                identity: { pluginId: 'acme.preview', localId: 'preview-card', qualifiedId: 'acme.preview/preview-card', generation: '7' },
                kind: params.kind,
                title: 'Preview',
                payload: params.payload,
                renderer: { identity: { pluginId: 'acme.preview', localId: 'summary-card' }, qualifiedId: 'acme.preview/summary-card', generation: '7' },
                actions: [],
                resources: [],
                fallback: { kind: 'summary', template: 'Preview unavailable' },
                visible: true,
            },
            renderer: {
                identity: { pluginId: 'acme.preview', localId: 'summary-card', qualifiedId: 'acme.preview/summary-card', generation: '7' },
                visible: true,
                requiredHostMethods: [],
                root: { kind: 'status', path: 'root', order: 0, label: 'Preview', value: 'Ready' },
                nodes: [{ kind: 'status', path: 'root', order: 0, label: 'Preview', value: 'Ready' }],
            },
            resources: [],
        },
    }));
});

describe('StructuredMessageBlock', () => {
    it('skips rendering when structured message props are referentially stable', async () => {
        const meta = {
            happier: {
                kind: 'participant_message.v1',
                payload: {
                    recipient: {
                        kind: 'agent_team_member',
                        teamId: 'team_1',
                        memberId: 'agent_1',
                        memberLabel: 'Alice',
                    },
                },
            },
        };
        let metaReadCount = 0;
        const message = {
            kind: 'user-text',
            id: 'm1',
            localId: null,
            createdAt: 1,
            text: 'hello there',
            get meta() {
                metaReadCount += 1;
                return meta;
            },
        } as any;
        const onJumpToAnchor = vi.fn();
        const renderBlock = () => (
            <StructuredMessageBlock
                message={message}
                sessionId="s1"
                onJumpToAnchor={onJumpToAnchor}
            />
        );
        const screen = await renderScreen(renderBlock());

        metaReadCount = 0;
        await act(async () => {
            screen.tree.update(renderBlock());
        });

        expect(metaReadCount).toBe(0);
    });

    it('renders projected plugin structured messages through host-owned renderer ids', async () => {
        const pluginUiProjection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
                    fallback: { kind: 'summary', template: 'Preview unavailable' },
                    renderer: { kind: 'host', rendererId: 'summaryCard' },
                    display: { titleKey: 'title' },
                    payloadSchema: { type: 'object' },
                },
            },
        };

        const screen = await renderScreen(<StructuredMessageBlock
            message={{
                kind: 'user-text',
                id: 'm_plugin',
                localId: null,
                createdAt: 1,
                text: 'Open preview',
                meta: {
                    happier: {
                        kind: 'acme.preview/preview-card.v1',
                        payload: { previewId: 'preview_1' },
                    },
                },
            } as any}
            sessionId="s1"
            onJumpToAnchor={() => {}}
            {...({ pluginUiProjection } as any)}
        />);

        expect(screen.findByTestId('plugin-structured-message-declarative')).toBeTruthy();
    });

    it('re-resolves a same-id plugin message when its projected payload changes', async () => {
        machinePluginStructuredMessageResolveMock.mockImplementation(async (
            _machineId: string,
            params: Readonly<{ kind: string; payload: unknown }>,
        ) => {
            const previewId = (params.payload as Readonly<{ previewId: string }>).previewId;
            return {
                supported: true,
                resolution: {
                    ok: true,
                    model: {
                        identity: { pluginId: 'acme.preview', localId: 'preview-card', qualifiedId: 'acme.preview/preview-card', generation: '7' },
                        kind: params.kind,
                        title: 'Preview',
                        payload: params.payload,
                        renderer: { identity: { pluginId: 'acme.preview', localId: 'summary-card' }, qualifiedId: 'acme.preview/summary-card', generation: '7' },
                        actions: [],
                        resources: [],
                        fallback: { kind: 'summary', template: 'Preview unavailable' },
                        visible: true,
                    },
                    renderer: {
                        identity: { pluginId: 'acme.preview', localId: 'summary-card', qualifiedId: 'acme.preview/summary-card', generation: '7' },
                        visible: true,
                        requiredHostMethods: [],
                        root: { kind: 'status', path: 'root', order: 0, label: 'Preview', value: previewId },
                        nodes: [{ kind: 'status', path: 'root', order: 0, label: 'Preview', value: previewId }],
                    },
                    resources: [],
                },
            };
        });
        const pluginUiProjection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
                    fallback: { kind: 'summary', template: 'Preview unavailable' },
                },
            },
        };
        const message = (previewId: string): UserTextMessage => ({
            kind: 'user-text',
            id: 'm_plugin',
            localId: null,
            createdAt: 1,
            text: 'Open preview',
            meta: {
                happier: {
                    kind: 'acme.preview/preview-card.v1',
                    payload: { previewId },
                },
            },
        });
        const renderBlock = (previewId: string) => (
            <StructuredMessageBlock
                message={message(previewId)}
                sessionId="s1"
                onJumpToAnchor={() => {}}
                pluginUiProjection={pluginUiProjection}
            />
        );
        const screen = await renderScreen(renderBlock('preview_1'));

        await act(async () => {
            screen.tree.update(renderBlock('preview_2'));
        });

        expect(machinePluginStructuredMessageResolveMock).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('preview_2');
    });

    it('aborts an in-flight plugin message resolution when the message unmounts', async () => {
        let observedSignal: AbortSignal | undefined;
        machinePluginStructuredMessageResolveMock.mockImplementationOnce(async (
            _machineId: string,
            params: Readonly<{ signal?: AbortSignal }>,
        ) => {
            observedSignal = params.signal;
            return await new Promise(() => {});
        });
        const pluginUiProjection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
                    fallback: { kind: 'summary', template: 'Preview unavailable' },
                },
            },
        };
        const screen = await renderScreen(<StructuredMessageBlock
            message={{
                kind: 'user-text',
                id: 'm_plugin',
                localId: null,
                createdAt: 1,
                text: 'Open preview',
                meta: {
                    happier: {
                        kind: 'acme.preview/preview-card.v1',
                        payload: { previewId: 'preview_1' },
                    },
                },
            }}
            sessionId="s1"
            onJumpToAnchor={() => {}}
            pluginUiProjection={pluginUiProjection}
        />);

        expect(observedSignal).toBeInstanceOf(AbortSignal);
        expect(observedSignal?.aborted).toBe(false);
        await act(async () => {
            screen.tree.unmount();
        });
        expect(observedSignal?.aborted).toBe(true);
    });

    it('submits at most one declarative action while pending and fails closed when it is rejected', async () => {
        machinePluginStructuredMessageResolveMock.mockResolvedValueOnce({
            supported: true,
            resolution: {
                ok: true,
                model: {
                    identity: { pluginId: 'acme.preview', localId: 'preview-card', qualifiedId: 'acme.preview/preview-card', generation: '7' },
                    kind: 'acme.preview/preview-card.v1',
                    title: 'Preview',
                    payload: { previewId: 'preview_1' },
                    renderer: { identity: { pluginId: 'acme.preview', localId: 'summary-card' }, qualifiedId: 'acme.preview/summary-card', generation: '7' },
                    actions: [{
                        identity: { pluginId: 'acme.preview', localId: 'open-preview' },
                        qualifiedId: 'acme.preview/open-preview',
                        generation: '7',
                        enabled: true,
                    }],
                    resources: [],
                    fallback: { kind: 'summary', template: 'Preview unavailable' },
                    visible: true,
                },
                renderer: {
                    identity: { pluginId: 'acme.preview', localId: 'summary-card', qualifiedId: 'acme.preview/summary-card', generation: '7' },
                    visible: true,
                    requiredHostMethods: [],
                    root: {
                        kind: 'action',
                        path: 'root',
                        order: 0,
                        label: 'Open preview',
                        action: { qualifiedId: 'acme.preview/open-preview' },
                        input: { previewId: 'preview_1' },
                        enabled: true,
                    },
                    nodes: [],
                },
                resources: [],
            },
        });
        let finishAction!: (result: {
            supported: true;
            result: { ok: false; code: string };
        }) => void;
        machinePluginStructuredMessageActionExecuteMock.mockImplementationOnce(
            async () => await new Promise((resolve) => { finishAction = resolve; }),
        );
        const pluginUiProjection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
                    fallback: { kind: 'summary', template: 'Preview unavailable' },
                },
            },
        };
        const message: UserTextMessage = {
                kind: 'user-text',
                id: 'm_plugin',
                localId: null,
                createdAt: 1,
                text: 'Open preview',
                meta: { happier: { kind: 'acme.preview/preview-card.v1', payload: { previewId: 'preview_1' } } },
        };
        const renderBlock = (interaction: typeof editableInteraction) => (
            <StructuredMessageBlock
                message={message}
                sessionId="s1"
                interaction={interaction}
                onJumpToAnchor={() => {}}
                pluginUiProjection={pluginUiProjection}
            />
        );
        const screen = await renderScreen(renderBlock(editableInteraction));

        const action = screen.findByTestId('plugin-declarative-action:acme.preview/open-preview');
        expect(action?.props.accessibilityRole).toBe('button');
        expect(action?.props.style?.minWidth).toBeGreaterThanOrEqual(44);
        expect(action?.props.style?.minHeight).toBeGreaterThanOrEqual(44);
        const retainedOnPress = action!.props.onPress;

        await act(async () => {
            screen.tree.update(renderBlock(publicInteraction));
        });
        expect(screen.findByTestId('plugin-declarative-action:acme.preview/open-preview')).toBeNull();
        await act(async () => {
            retainedOnPress();
            await Promise.resolve();
        });
        expect(machinePluginStructuredMessageActionExecuteMock).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.update(renderBlock(editableInteraction));
        });
        await act(async () => {
            screen.pressByTestId('plugin-declarative-action:acme.preview/open-preview');
            screen.pressByTestId('plugin-declarative-action:acme.preview/open-preview');
        });

        expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenCalledTimes(1);
        expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: { previewId: 'preview_1' },
            sessionId: 's1',
            executionSurface: 'ui',
        });

        await act(async () => {
            finishAction({
                supported: true,
                result: { ok: false, code: 'plugin_action_unavailable' },
            });
        });
        expect(screen.findByTestId('structured-message-summary-fallback')).toBeTruthy();
    });

    it('interprets null-prototype structured-message enum payloads with JSON equality semantics', async () => {
        const pluginUiProjection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
                    fallback: { kind: 'summary', template: 'Preview unavailable' },
                    renderer: { kind: 'host', rendererId: 'summaryCard' },
                    display: { titleKey: 'title' },
                    payloadSchema: {
                        enum: [{ valueOf: 'literal', nested: [{ enabled: true }], amount: 4 }],
                    },
                },
            },
        };
        const payload = Object.assign(Object.create(null) as Record<string, unknown>, {
            amount: 4,
            nested: [Object.assign(Object.create(null) as Record<string, unknown>, { enabled: true })],
            valueOf: 'literal',
        });

        const screen = await renderScreen(<StructuredMessageBlock
            message={{
                kind: 'user-text',
                id: 'm_plugin_enum',
                localId: null,
                createdAt: 1,
                text: 'Open preview',
                meta: { happier: { kind: 'acme.preview/preview-card.v1', payload } },
            } as any}
            sessionId="s1"
            onJumpToAnchor={() => {}}
            {...({ pluginUiProjection } as any)}
        />);

        expect(screen.findByTestId('plugin-structured-message-declarative')).toBeTruthy();
    });

    it('rejects accessor-backed structured-message enum payloads without invoking the accessor', async () => {
        machinePluginStructuredMessageResolveMock.mockResolvedValueOnce({
            supported: true,
            resolution: { ok: false, code: 'plugin_structured_message_payload_invalid', reason: 'invalid_payload' },
        });
        const pluginUiProjection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
                    fallback: { kind: 'summary', template: 'Preview unavailable' },
                    renderer: { kind: 'host', rendererId: 'summaryCard' },
                    display: { titleKey: 'title' },
                    payloadSchema: { const: { valueOf: 'literal', enabled: true } },
                },
            },
        };
        let accessorReads = 0;
        const payload = { enabled: true } as Record<string, unknown>;
        Object.defineProperty(payload, 'valueOf', {
            enumerable: true,
            get() {
                accessorReads += 1;
                throw new Error('accessor must not execute');
            },
        });

        const screen = await renderScreen(<StructuredMessageBlock
            message={{
                kind: 'user-text',
                id: 'm_plugin_accessor',
                localId: null,
                createdAt: 1,
                text: 'Open preview',
                meta: { happier: { kind: 'acme.preview/preview-card.v1', payload } },
            } as any}
            sessionId="s1"
            onJumpToAnchor={() => {}}
            {...({ pluginUiProjection } as any)}
        />);

        expect(screen.findByTestId('structured-message-summary-fallback')).toBeTruthy();
        expect(accessorReads).toBe(0);
    });

    it('does not render projected plugin structured messages with deferred policy until the host can evaluate it', async () => {
        machinePluginStructuredMessageResolveMock.mockResolvedValueOnce({
            supported: true,
            resolution: { ok: false, code: 'plugin_contribution_policy_fact_unavailable', reason: 'unavailable' },
        });
        const pluginUiProjection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
                    fallback: { kind: 'summary', template: 'Preview unavailable' },
                    renderer: { kind: 'host', rendererId: 'summaryCard' },
                    display: { titleKey: 'title' },
                    payloadSchema: { type: 'object' },
                    visibility: { operand: 'platform.is', value: 'web' },
                },
            },
        };

        const screen = await renderScreen(<StructuredMessageBlock
            message={{
                kind: 'user-text',
                id: 'm_plugin',
                localId: null,
                createdAt: 1,
                text: 'Open preview',
                meta: {
                    happier: {
                        kind: 'acme.preview/preview-card.v1',
                        payload: { previewId: 'preview_1' },
                    },
                },
            } as any}
            sessionId="s1"
            onJumpToAnchor={() => {}}
            {...({ pluginUiProjection } as any)}
        />);

        expect(screen.findByTestId('structured-message-summary-fallback')).toBeTruthy();
    });

    it('renders a stable host fallback for projected plugin structured messages with unknown host renderers', async () => {
        machinePluginStructuredMessageResolveMock.mockResolvedValueOnce({
            supported: true,
            resolution: { ok: false, code: 'plugin_structured_message_renderer_missing', reason: 'unavailable' },
        });
        const pluginUiProjection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
                    fallback: { kind: 'summary', template: 'Preview unavailable' },
                    renderer: { kind: 'host', rendererId: 'customRenderer' },
                    display: { titleKey: 'title' },
                    payloadSchema: { type: 'object' },
                },
            },
        };
        const message = {
            kind: 'user-text',
            id: 'm_plugin',
            localId: null,
            createdAt: 1,
            text: 'Open preview',
            meta: {
                happier: {
                    kind: 'acme.preview/preview-card.v1',
                    payload: { previewId: 'preview_1' },
                },
            },
        } satisfies UserTextMessage;

        const screen = await renderScreen(<StructuredMessageBlock
            message={message}
            sessionId="s1"
            onJumpToAnchor={() => {}}
            pluginUiProjection={pluginUiProjection}
        />);

        expect(screen.findByTestId('structured-message-summary-fallback')).toBeTruthy();
    });

    it('renders a stable host fallback for projected plugin structured messages with malformed host renderers', async () => {
        machinePluginStructuredMessageResolveMock.mockResolvedValueOnce({
            supported: true,
            resolution: { ok: false, code: 'plugin_structured_message_renderer_invalid', reason: 'unavailable' },
        });
        const pluginUiProjection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
                    fallback: { kind: 'summary', template: 'Preview unavailable' },
                    renderer: { kind: 'host', rendererId: '' },
                    display: { titleKey: 'title' },
                    payloadSchema: { type: 'object' },
                },
            },
        };
        const message = {
            kind: 'user-text',
            id: 'm_plugin',
            localId: null,
            createdAt: 1,
            text: 'Open preview',
            meta: {
                happier: {
                    kind: 'acme.preview/preview-card.v1',
                    payload: { previewId: 'preview_1' },
                },
            },
        } satisfies UserTextMessage;

        const screen = await renderScreen(<StructuredMessageBlock
            message={message}
            sessionId="s1"
            onJumpToAnchor={() => {}}
            pluginUiProjection={pluginUiProjection}
        />);

        expect(screen.findByTestId('structured-message-summary-fallback')).toBeTruthy();
    });

    it('renders a stable host fallback for unknown structured message kinds', async () => {
        const screen = await renderScreen(<StructuredMessageBlock
            message={{ meta: { happier: { kind: 'unknown.v1', payload: {} } } } as any}
            sessionId="s1"
            onJumpToAnchor={() => {}}
        />);

        expect(screen.findByTestId('structured-message-unavailable')).toBeTruthy();
    });

    it('renders a stable host fallback for malformed structured message payloads', async () => {
        const screen = await renderScreen(<StructuredMessageBlock
            message={{
                meta: {
                    happier: {
                        kind: 'review_comments.v1',
                        payload: { comments: 'not-an-array' },
                    },
                },
            } as any}
            sessionId="s1"
            onJumpToAnchor={() => {}}
        />);

        expect(screen.findByTestId('structured-message-unavailable')).toBeTruthy();
    });

    it('renders review comments card for valid payload', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<StructuredMessageBlock
                    message={{
                        meta: {
                            happier: {
                                kind: 'review_comments.v1',
                                payload: {
                                    sessionId: 's1',
                                    comments: [
                                        {
                                            id: 'c1',
                                            filePath: 'src/a.ts',
                                            source: 'file',
                                            anchor: { kind: 'fileLine', startLine: 1 },
                                            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                                            body: 'nit',
                                            createdAt: 1,
                                        },
                                    ],
                                },
                            },
                        },
                    } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />)).tree;

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('Review comments');
        expect(serialized).toContain('src/a.ts');
    });

    it('renders participant message card for valid payload', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<StructuredMessageBlock
                    message={{
                        kind: 'user-text',
                        id: 'm1',
                        localId: null,
                        createdAt: 1,
                        text: 'hello there',
                        meta: {
                            happier: {
                                kind: 'participant_message.v1',
                                payload: {
                                    recipient: {
                                        kind: 'agent_team_member',
                                        teamId: 'team_1',
                                        memberId: 'agent_1',
                                        memberLabel: 'Alice',
                                    },
                                },
                            },
                        },
                    } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />)).tree;

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('To:');
        expect(serialized).toContain('Alice');
        expect(serialized).toContain('hello there');

        const findTextNode = (text: string) =>
            tree!.findAll((n: any) => n.type === 'Text' && n.props?.children === text)[0]!;
        expect(findTextNode('hello there').props.selectable).toBe(true);
    });

    it('renders subagent launch card for valid payload', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<StructuredMessageBlock
                    message={{
                        kind: 'user-text',
                        id: 'm_launch',
                        localId: null,
                        createdAt: 1,
                        text: 'Launch the alpha teammate',
                        meta: {
                            happier: {
                                kind: 'subagent_launch.v1',
                                payload: {
                                    kind: 'agent_team_member_create',
                                    teamId: 'team_1',
                                    memberLabel: 'alpha',
                                    instructions: 'Handle the linting lane',
                                    runInBackground: true,
                                },
                            },
                        },
                    } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />)).tree;

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('alpha');
        expect(serialized).toContain('Launch the alpha teammate');
    });

    it('renders subagent command card for valid payload', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<StructuredMessageBlock
                    message={{
                        kind: 'user-text',
                        id: 'm_command',
                        localId: null,
                        createdAt: 1,
                        text: 'Shut alpha down',
                        meta: {
                            happier: {
                                kind: 'subagent_command.v1',
                                payload: {
                                    kind: 'agent_team_member_delete',
                                    teamId: 'team_1',
                                    memberId: 'alpha@team_1',
                                    memberLabel: 'alpha',
                                },
                            },
                        },
                    } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />)).tree;

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('alpha');
        expect(serialized).toContain('Shut alpha down');
    });
});
