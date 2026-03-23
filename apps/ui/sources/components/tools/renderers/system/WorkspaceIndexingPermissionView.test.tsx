import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shell/presentation/ToolSectionView', () => ({
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

        const screen = await renderScreen(React.createElement(WorkspaceIndexingPermissionView, { tool, metadata: null, messages: [] } as any));
        const joined = screen.getTextContent();

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

        const screen = await renderScreen(React.createElement(WorkspaceIndexingPermissionView, { tool, metadata: null, messages: [], detailLevel: 'full' } as any));
        const joined = screen.getTextContent();
        expect(joined).toContain('Indexing helps the agent search your codebase faster');
        expect(joined).toContain('Choose an option below to continue.');
    });
});
