import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    Platform: { OS: 'ios', select: (v: any) => v.ios },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

let toolDetailSetting: any = 'summary';

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewDetailLevelDefault') return toolDetailSetting;
        if (key === 'toolViewDetailLevelDefaultLocalControl') return 'summary';
        if (key === 'toolViewDetailLevelByToolName') return {};
        return null;
    },
}));

let mockedToolName = 'edit';
let mockedToolInput: any = { path: 'file.ts' };
let mockedHeaderText: any = { normalizedToolName: 'edit', title: 'Edit', subtitle: null, statusText: null };

vi.mock('@/components/tools/shell/permissions/presentation/buildPermissionPromptModel', () => ({
    buildPermissionPromptModel: () => ({
        request: { id: 'perm1', tool: 'edit', arguments: {} },
        tool: {
            name: mockedToolName,
            state: 'running',
            input: mockedToolInput,
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: null,
            result: null,
            permission: { id: 'perm1', status: 'pending' },
        },
        headerText: mockedHeaderText,
    }),
}));

vi.mock('@/components/tools/shell/views/ToolInlineBody', () => ({
    ToolInlineBody: (props: any) => React.createElement('ToolInlineBody', props),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

describe('PermissionPromptCard (preview)', () => {
    it('renders a tool preview when detail level is not title', async () => {
        toolDetailSetting = 'summary';
        mockedToolName = 'edit';
        mockedToolInput = { path: 'file.ts' };
        mockedHeaderText = { normalizedToolName: 'edit', title: 'Edit', subtitle: null, statusText: null };
        const { PermissionPromptCard } = await import('./PermissionPromptCard');

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />,
            );
        });

        expect(tree!.root.findAllByType('ToolInlineBody' as any)).toHaveLength(1);
    });

    it('hides the tool preview when detail level is title', async () => {
        toolDetailSetting = 'title';
        mockedToolName = 'edit';
        mockedToolInput = { path: 'file.ts' };
        mockedHeaderText = { normalizedToolName: 'edit', title: 'Edit', subtitle: null, statusText: null };
        const { PermissionPromptCard } = await import('./PermissionPromptCard');

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />,
            );
        });

        expect(tree!.root.findAllByType('ToolInlineBody' as any)).toHaveLength(0);
    });

    it('hides the tool preview when detail level is compact', async () => {
        toolDetailSetting = 'compact';
        mockedToolName = 'edit';
        mockedToolInput = { path: 'file.ts' };
        mockedHeaderText = { normalizedToolName: 'edit', title: 'Edit', subtitle: null, statusText: null };
        const { PermissionPromptCard } = await import('./PermissionPromptCard');

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />,
            );
        });

        expect(tree!.root.findAllByType('ToolInlineBody' as any)).toHaveLength(0);
    });

    it('does not repeat a shell command subtitle when a preview is visible', async () => {
        toolDetailSetting = 'summary';
        mockedToolName = 'Bash';
        mockedToolInput = { command: 'COMMAND_SUBTITLE' };
        mockedHeaderText = { normalizedToolName: 'Bash', title: 'Run command', subtitle: 'COMMAND_SUBTITLE', statusText: null };
        const { PermissionPromptCard } = await import('./PermissionPromptCard');

        const request = { id: 'perm1', tool: 'Bash', arguments: { command: 'COMMAND_SUBTITLE' } } as PendingPermissionRequest;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />,
            );
        });

        const texts = tree!.root.findAllByType('Text' as any);
        const flattened = texts
            .map((t) => t.props.children)
            .flat()
            .filter((c) => typeof c === 'string') as string[];

        expect(flattened).not.toContain('COMMAND_SUBTITLE');
        expect(tree!.root.findAllByType('ToolInlineBody' as any)).toHaveLength(1);
    });
});
