import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionFooter } from '../permissions/PermissionFooter';
import { installPermissionShellCommonModuleMocks, createPermissionShellRenderer } from './permissionShellTestHelpers';



(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const renderScreen = createPermissionShellRenderer();


installPermissionShellCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            importOriginal,
            storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));



vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: vi.fn(async () => {}),
    },
}));

vi.mock('@/agents/catalog/resolve', () => ({
    resolveAgentIdForPermissionUi: () => 'claude',
}));

vi.mock('@/agents/catalog/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => ({
        protocol: 'claude',
        yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
        yesForToolKey: 'claude.permissions.yesForTool',
        stopKey: 'claude.permissions.stop',
    }),
}));

describe('PermissionFooter summary visibility', () => {
    it('does not render when approvals are disabled due to inactive session', async () => {
        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'Bash',
            toolInput: { command: 'pwd' },
            metadata: { flavor: 'opencode' },
            canApprovePermissions: true,
            disabledReason: 'inactive',
        }));

        expect(screen.getTextContent()).not.toContain('SUMMARY');
    });

    it('tells a viewer who cannot answer who can, without repeating the request the card title names', async () => {
        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'mcp__happier__action_spec_get',
            toolInput: { id: 'session.list' },
            metadata: { flavor: 'claude' },
            canApprovePermissions: false,
            disabledReason: 'readOnly',
        }));

        // The footer explains who can answer; the request itself stays in the card title, named once.
        const text = screen.getTextContent();
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/get action spec|mcp__/i);
    });

    it('does not repeat the request summary (the tool UI already shows it)', async () => {
        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'Bash',
            toolInput: { command: 'pwd' },
            metadata: { flavor: 'opencode' },
        }));

        const texts = screen.findAllByType('Text' as any);
        const flattened = texts
            .map((t) => t.props.children)
            .flat()
            .filter((c) => typeof c === 'string') as string[];

        expect(flattened).not.toContain('SUMMARY');
        expect(screen.findAllByType('TouchableOpacity')).not.toHaveLength(0);
    });
});
