import React from 'react';
import renderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessageStructuredPresentationV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import {
    createPluginMessageActionHost,
    PluginMessageActionHostProvider,
} from '@/components/sessions/transcript/messageActions/PluginMessageActions';
import type { PluginContributedActionCurrentSnapshot } from '@/components/plugins/actions/pluginContributedActionController';
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
    machinePluginActionFormConnectedAccountOptionsResolve: vi.fn(),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
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
});

describe('StructuredMessageBlock', () => {
    it('renders a persisted structured snapshot without resolving current daemon content', async () => {
        const screen = await renderScreen(
            <StructuredMessageBlock
                message={{
                    kind: 'agent-text',
                    id: 'persisted-plugin-transcript',
                    localId: null,
                    createdAt: 1,
                    text: '',
                    // An old normalizer marker cannot override a valid
                    // persisted snapshot: snapshot replay stays the
                    // authoritative historical representation.
                    meta: { happierUnsupportedContentV1: 'unsupported-transcript-record' },
                    structuredPresentation: createMessageStructuredPresentationV1({
                        owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                        snapshot: { kind: 'status', label: 'Report', value: 'Ready' },
                    }),
                }}
                sessionId="s1"
                interaction={editableInteraction}
                onJumpToAnchor={() => {}}
            />,
        );

        expect(screen.findByTestId('plugin-structured-message-declarative')).toBeTruthy();
        expect(screen.findByTestId('plugin-declarative-status')).toBeTruthy();
        expect(machinePluginStructuredMessageResolveMock).not.toHaveBeenCalled();
    });

    it('does not render a prohibited Field when corrupt content bypasses the upstream parser', async () => {
        const screen = await renderScreen(
            <StructuredMessageBlock
                // Boundary fixture: deliberately bypass the transport normalizer to exercise the replay losing path.
                message={{
                    kind: 'agent-text',
                    id: 'corrupt-plugin-transcript-field',
                    localId: null,
                    createdAt: 1,
                    text: '',
                    structuredPresentation: {
                        v: 1,
                        profile: 'pluginTranscriptV1',
                        owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                        snapshot: {
                            kind: 'field',
                            label: 'Forbidden persisted setting',
                            control: { kind: 'text', settingId: 'report-setting' },
                        },
                    },
                } as any}
                sessionId="s1"
                interaction={editableInteraction}
                onJumpToAnchor={() => {}}
            />,
        );

        expect(
            screen.tree.findAll((node: any) => (
                node.type === 'Text' && node.props.children === 'Forbidden persisted setting'
            )),
        ).toHaveLength(0);
    });

    it('retains a persisted Action as unavailable instead of silently hiding it', async () => {
        const screen = await renderScreen(
            <StructuredMessageBlock
                message={{
                    kind: 'agent-text',
                    id: 'persisted-plugin-action',
                    localId: null,
                    createdAt: 1,
                    text: '',
                    structuredPresentation: createMessageStructuredPresentationV1({
                        owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                        snapshot: {
                            kind: 'action',
                            action: 'open-report',
                            label: 'Open report',
                        },
                    }),
                }}
                sessionId="s1"
                interaction={editableInteraction}
                onJumpToAnchor={() => {}}
            />,
        );

        const action = screen.findByTestId('plugin-declarative-action:acme.preview/open-report');
        expect(action).toBeTruthy();
        expect(action?.props.disabled).toBe(true);
        expect(screen.findByTestId('plugin-declarative-action-label:acme.preview/open-report')).toBeTruthy();
        expect(machinePluginStructuredMessageResolveMock).not.toHaveBeenCalled();
    });

    it('dispatches a persisted Action under current host Message intent without inventing a mounted caller', async () => {
        const messageActionReference = {
            v: 1 as const,
            sessionId: 's1',
            messageId: 'persisted-plugin-action-current',
            observedRevision: 'revision-1',
        };
        const actionSnapshot: PluginContributedActionCurrentSnapshot = {
            pluginProjectionById: {
                'acme.preview': {
                    pluginId: 'acme.preview',
                    title: 'Preview',
                    description: null,
                    version: '1.0.0',
                    enabled: true,
                    generation: 7,
                    generationLabel: '7',
                    status: null,
                    provenance: null,
                    diagnostics: [],
                    resources: [],
                    editableSettingsGroups: [],
                        actions: [{
                            id: 'open-report',
                            title: 'Current report Action title',
                            description: null,
                            icon: null,
                            scopes: ['message'],
                            surfaces: ['ui'],
                            placementBindings: ['message.menu'],
                            inputSchema: null,
                            inputHints: null,
                            priority: null,
                            dangerLevel: 'safe',
                        confirmation: null,
                        available: true,
                    }],
                },
            },
            host: {
                machineId: 'machine-1',
                serverId: 'server-1',
                expectedGeneration: '7',
                sessionId: 's1',
                isCurrent: () => true,
            },
        };
        const actionHost = createPluginMessageActionHost({
            resolveCurrent: () => actionSnapshot,
            sessionId: 's1',
        });
        const screen = await renderScreen(
            <PluginMessageActionHostProvider host={actionHost}>
                <StructuredMessageBlock
                    message={{
                        kind: 'agent-text',
                        id: 'persisted-plugin-action-current',
                        localId: null,
                        createdAt: 1,
                        text: '',
                        messageActionReference,
                        structuredPresentation: createMessageStructuredPresentationV1({
                            owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                            snapshot: {
                                kind: 'action',
                                action: 'open-report',
                                label: 'Historical report label',
                                input: { reportId: 'report-1' },
                            },
                        }),
                    }}
                    sessionId="s1"
                    interaction={editableInteraction}
                    onJumpToAnchor={() => {}}
                />
            </PluginMessageActionHostProvider>,
        );

        expect(
            screen.findByTestId('plugin-declarative-action-label:acme.preview/open-report')?.props.children,
        ).toBe('Historical report label');
        await act(async () => {
            screen.pressByTestId('plugin-declarative-action:acme.preview/open-report');
        });

        // The immutable owner is presentation data, not a current mounted
        // caller binding. The generic controller re-reads the Message-owned
        // intent at dispatch time and forwards it to the canonical daemon
        // action owner without reviving the retired structured-message route.
        expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-report',
            input: { reportId: 'report-1' },
            executionSurface: 'ui',
            sessionId: 's1',
            messageActionReference,
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: messageActionReference,
            },
        });
        expect(machinePluginStructuredMessageResolveMock).not.toHaveBeenCalled();
    });

    it('shows a retired persisted Action as unavailable without rebinding its historical node', async () => {
        const messageActionReference = {
            v: 1 as const,
            sessionId: 's1',
            messageId: 'persisted-plugin-action-retired',
            observedRevision: 'revision-2',
        };
        const actionHost = createPluginMessageActionHost({
            resolveCurrent: () => ({
                pluginProjectionById: {
                    'acme.preview': {
                        pluginId: 'acme.preview',
                        title: 'Preview',
                        description: null,
                        version: '1.0.0',
                        enabled: true,
                        generation: 7,
                        generationLabel: '7',
                        status: null,
                        provenance: null,
                        diagnostics: [],
                        resources: [],
                        editableSettingsGroups: [],
                        actions: [{
                            id: 'open-report',
                            title: 'New report Action title',
                            icon: null,
                            description: null,
                            scopes: ['message'],
                            surfaces: ['ui'],
                            placementBindings: ['rowAction'],
                            inputSchema: null,
                            inputHints: null,
                            priority: null,
                            dangerLevel: 'safe',
                            confirmation: null,
                            available: false,
                        }],
                    },
                },
                host: {
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    expectedGeneration: '7',
                    sessionId: 's1',
                    isCurrent: () => true,
                },
            }),
            sessionId: 's1',
        });
        const screen = await renderScreen(
            <PluginMessageActionHostProvider host={actionHost}>
                <StructuredMessageBlock
                    message={{
                        kind: 'agent-text',
                        id: 'persisted-plugin-action-retired',
                        localId: null,
                        createdAt: 1,
                        text: '',
                        messageActionReference,
                        structuredPresentation: createMessageStructuredPresentationV1({
                            owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                            snapshot: {
                                kind: 'action',
                                action: 'open-report',
                                label: 'Historical report label',
                                input: { reportId: 'report-1' },
                            },
                        }),
                    }}
                    sessionId="s1"
                    interaction={editableInteraction}
                    onJumpToAnchor={() => {}}
                />
            </PluginMessageActionHostProvider>,
        );

        const action = screen.findByTestId('plugin-declarative-action:acme.preview/open-report');
        expect(action?.props.disabled).toBe(true);
        expect(
            screen.findByTestId('plugin-declarative-action-label:acme.preview/open-report')?.props.children,
        ).toBe('Historical report label');
        await act(async () => {
            screen.pressByTestId('plugin-declarative-action:acme.preview/open-report');
        });
        expect(machinePluginStructuredMessageActionExecuteMock).not.toHaveBeenCalled();
        expect(machinePluginStructuredMessageResolveMock).not.toHaveBeenCalled();
    });

    it('does not revive an unsupported historical record through the legacy plugin resolver', async () => {
        const screen = await renderScreen(
            <StructuredMessageBlock
                message={{
                    kind: 'agent-text',
                    id: 'future-plugin-transcript',
                    localId: null,
                    createdAt: 1,
                    text: '[Unsupported transcript record]',
                    meta: {
                        happier: {
                            kind: 'acme.preview/preview-card.v1',
                            payload: { previewId: 'should-not-resolve' },
                        },
                        happierUnsupportedContentV1: 'unsupported-transcript-record',
                    },
                }}
                sessionId="s1"
                interaction={editableInteraction}
                onJumpToAnchor={() => {}}
            />,
        );

        expect(screen.findByTestId('structured-message-unavailable')).toBeTruthy();
        expect(machinePluginStructuredMessageResolveMock).not.toHaveBeenCalled();
    });

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

    it('does not resolve an unpersisted generic plugin envelope during replay', async () => {
        // This is deliberately shaped like the pre-snapshot current registry.
        // Reintroducing the old `pluginUiProjection`-driven branch would make
        // this unknown historical record call the retired resolver.
        const legacyProjection = {
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
            } as any}
            sessionId="s1"
            onJumpToAnchor={() => {}}
            {...({ pluginUiProjection: legacyProjection } as any)}
        />);

        expect(screen.findByTestId('structured-message-unavailable')).toBeTruthy();
        expect(machinePluginStructuredMessageResolveMock).not.toHaveBeenCalled();
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
