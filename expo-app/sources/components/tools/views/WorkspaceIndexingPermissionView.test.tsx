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

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('WorkspaceIndexingPermissionView', () => {
    it('renders a compact summary by default', async () => {
        const { WorkspaceIndexingPermissionView } = await import('./WorkspaceIndexingPermissionView');

        const tool: ToolCall = {
            name: 'WorkspaceIndexingPermission',
            state: 'running',
            input: {
                title: 'Workspace Indexing Permission',
                options: [
                    { id: 'enable', name: 'Enable indexing' },
                    { id: 'disable', name: 'Skip indexing' },
                    { id: 'later', name: 'Ask later' },
                ],
            } as any,
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(WorkspaceIndexingPermissionView, { tool, metadata: null, messages: [] } as any));
        });

        const texts = tree.root.findAllByType('Text' as any).map((n: any) => n.props.children);
        const flattened = texts.flatMap((c: any) => Array.isArray(c) ? c : [c]).filter((c: any) => typeof c === 'string' || typeof c === 'number');
        const joined = flattened.map(String).join(' ');

        expect(joined).toContain('Workspace Indexing Permission');
        expect(joined).toContain('Enable indexing');
        expect(joined).toContain('Skip indexing');
        expect(joined).toContain('more');
        expect(joined).not.toContain('Indexing helps the agent search');
    });

    it('renders the full explanation when detailLevel=full', async () => {
        const { WorkspaceIndexingPermissionView } = await import('./WorkspaceIndexingPermissionView');

        const tool: ToolCall = {
            name: 'WorkspaceIndexingPermission',
            state: 'running',
            input: {
                title: 'Workspace Indexing Permission',
                options: [
                    { id: 'enable', name: 'Enable indexing' },
                    { id: 'disable', name: 'Skip indexing' },
                ],
            } as any,
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(WorkspaceIndexingPermissionView, { tool, metadata: null, messages: [], detailLevel: 'full' } as any)
            );
        });

        const joined = tree.root.findAllByType('Text' as any).map((n: any) => String(n.props.children)).join(' ');
        expect(joined).toContain('Indexing helps the agent search your codebase faster');
        expect(joined).toContain('Choose an option below to continue.');
    });
});

