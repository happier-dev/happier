import React from 'react';
import renderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { UserTextMessage } from '@/sync/domains/messages/messageTypes';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';


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

let StructuredMessageBlock: typeof import('./StructuredMessageBlock').StructuredMessageBlock;

beforeAll(async () => {
    ({ StructuredMessageBlock } = await import('./StructuredMessageBlock'));
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
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
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

        expect(screen.findByTestId('plugin-structured-message-summaryCard')).toBeTruthy();
    });

    it('does not render projected plugin structured messages with deferred policy until the host can evaluate it', async () => {
        const pluginUiProjection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
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

        expect(screen.findByTestId('structured-message-unavailable')).toBeTruthy();
    });

    it('renders a stable host fallback for projected plugin structured messages with unknown host renderers', async () => {
        const pluginUiProjection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
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

        expect(screen.findByTestId('structured-message-unavailable')).toBeTruthy();
    });

    it('renders a stable host fallback for projected plugin structured messages with malformed host renderers', async () => {
        const pluginUiProjection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            structuredMessagesByKind: {
                'acme.preview/preview-card.v1': {
                    id: 'structuredMessage:acme.preview:preview-card',
                    pluginId: 'acme.preview',
                    contributionKind: 'structuredMessage',
                    descriptorId: 'preview-card',
                    kind: 'acme.preview/preview-card.v1',
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

        expect(screen.findByTestId('structured-message-unavailable')).toBeTruthy();
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
