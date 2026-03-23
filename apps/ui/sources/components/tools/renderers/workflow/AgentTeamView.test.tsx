import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';

import { collectHostText, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installWorkflowRendererCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => {
                const last = key.split('.').pop() ?? key;
                return last.charAt(0).toUpperCase() + last.slice(1);
            },
        });
    },
});

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: ({ code }: any) => React.createElement('CodeView', { code }),
}));

describe('AgentTeamView', () => {
    let AgentTeamView!: React.ComponentType<ReturnType<typeof makeToolViewProps>>;

    beforeAll(async () => {
        ({ AgentTeamView } = await import('./AgentTeamView'));
    }, 60_000);

    async function renderTool(tool: ReturnType<typeof makeToolCall>): Promise<renderer.ReactTestRenderer> {
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(AgentTeamView, makeToolViewProps(tool)))).tree;
        return tree;
    }

    it('renders create-team structured fields', async () => {
        const tool = makeToolCall({
            name: 'AgentTeamCreate',
            state: 'completed',
            input: {
                team_name: 'probe',
                description: 'qa team',
            },
            result: {
                status: 'created',
                tool_use_result: {
                    team_name: 'probe',
                },
            },
        });

        const tree = await renderTool(tool);
        const renderedText = collectHostText(tree);
        expect(renderedText).toContain('Agent Team Create');
        expect(renderedText).toContain('Team');
        expect(renderedText).toContain('probe');
        expect(renderedText).toContain('Description');
        expect(renderedText).toContain('qa team');
        expect(renderedText).toContain('Status');
        expect(renderedText).toContain('created');
    });

    it('renders delete-team structured fields', async () => {
        const tool = makeToolCall({
            name: 'AgentTeamDelete',
            state: 'completed',
            input: {
                team_name: 'probe',
            },
            result: {
                tool_use_result: {
                    status: 'deleted',
                    team_name: 'probe',
                },
            },
        });

        const tree = await renderTool(tool);
        const renderedText = collectHostText(tree);
        expect(renderedText).toContain('Agent Team Delete');
        expect(renderedText).toContain('Team');
        expect(renderedText).toContain('probe');
        expect(renderedText).toContain('Status');
        expect(renderedText).toContain('deleted');
    });

    it('renders stable structured fields before raw json fallback', async () => {
        const tool = makeToolCall({
            name: 'AgentTeamSendMessage',
            state: 'completed',
            input: {
                team_name: 'probe',
                type: 'broadcast',
                content: 'hello team',
            },
            result: {
                tool_use_result: {
                    status: 'delivered',
                },
            },
        });

        const tree = await renderTool(tool);
        const renderedText = collectHostText(tree);
        expect(renderedText).toContain('Agent Team Send Message');
        expect(renderedText).toContain('Team');
        expect(renderedText).toContain('probe');
        expect(renderedText).toContain('Type');
        expect(renderedText).toContain('broadcast');
        expect(renderedText).toContain('Content');
        expect(renderedText).toContain('hello team');
        expect(renderedText).toContain('Status');
        expect(renderedText).toContain('delivered');
    });
});
