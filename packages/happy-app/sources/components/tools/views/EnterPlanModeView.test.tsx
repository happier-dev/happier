import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('../ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('EnterPlanModeView', () => {
    it('renders a compact marker by default', async () => {
        const { EnterPlanModeView } = await import('./EnterPlanModeView');

        const tool: ToolCall = {
            name: 'EnterPlanMode',
            state: 'completed',
            input: {},
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(EnterPlanModeView, { tool, metadata: null, messages: [] } as any));
        });

        const joined = tree.root.findAllByType('Text' as any).map((n: any) => String(n.props.children)).join(' ');
        expect(joined).toContain('Entered plan mode');
        expect(joined).not.toContain('structured plan');
    });

    it('renders the full explanation when detailLevel=full', async () => {
        const { EnterPlanModeView } = await import('./EnterPlanModeView');

        const tool: ToolCall = {
            name: 'EnterPlanMode',
            state: 'completed',
            input: {},
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(EnterPlanModeView, { tool, metadata: null, messages: [], detailLevel: 'full' } as any));
        });

        const joined = tree.root.findAllByType('Text' as any).map((n: any) => String(n.props.children)).join(' ');
        expect(joined).toContain('structured plan');
    });

    it('renders nothing when detailLevel=title', async () => {
        const { EnterPlanModeView } = await import('./EnterPlanModeView');

        const tool: ToolCall = {
            name: 'EnterPlanMode',
            state: 'completed',
            input: {},
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(EnterPlanModeView, { tool, metadata: null, messages: [], detailLevel: 'title' } as any));
        });

        expect(tree.root.findAllByType('Text' as any).length).toBe(0);
    });
});

