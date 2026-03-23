import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { renderScreen } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const routerPush = vi.fn();

let toolDetailSetting: any = 'summary';

installPermissionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            Platform: {
                OS: 'ios',
                select: (v: any) => v.ios,
            },
            AppState: {
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPush },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            importOriginal,
            useSetting: (key: string) => {
                if (key === 'toolViewDetailLevelDefault') return toolDetailSetting;
                if (key === 'toolViewDetailLevelDefaultLocalControl') return 'summary';
                if (key === 'toolViewDetailLevelByToolName') return {};
                return null;
            },
        });
    },
});

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
    ToolInlineBody: (props: any) => React.createElement('ToolInlineBody', { ...props, testID: 'permission-prompt-tool-inline-body' }),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

describe('PermissionPromptCard (preview)', () => {
    it('hides the open-details action when the prompt location is not durably addressable', async () => {
        toolDetailSetting = 'summary';
        mockedToolName = 'edit';
        mockedToolInput = { path: 'file.ts' };
        mockedHeaderText = { normalizedToolName: 'edit', title: 'Edit', subtitle: null, statusText: null };
        const { PermissionPromptCard } = await import('./PermissionPromptCard');

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderScreen(<PermissionPromptCard
                    request={request}
                    location={{
                        kind: 'top',
                        messageId: 'v0k1hmbmnud',
                        seq: null,
                    }}
                    sessionId="session-1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        expect(screen.findByTestId('permission-prompt-view-tool')).toBeNull();
    });

    it('opens nested tool routes with stable encoded route ids', async () => {
        toolDetailSetting = 'summary';
        mockedToolName = 'edit';
        mockedToolInput = { path: 'file.ts' };
        mockedHeaderText = { normalizedToolName: 'edit', title: 'Edit', subtitle: null, statusText: null };
        routerPush.mockReset();
        const { PermissionPromptCard } = await import('./PermissionPromptCard');

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderScreen(<PermissionPromptCard
                    request={request}
                    location={{
                        kind: 'nested',
                        parentMessageId: 'tool:call:parent/1',
                        messageId: 'tool:call:child/2',
                        seq: 12,
                    }}
                    sessionId="session-1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        const viewToolButton = screen.findByTestId('permission-prompt-view-tool');
        expect(viewToolButton).toBeTruthy();

        await act(async () => {
            viewToolButton!.props.onPress();
        });

        expect(routerPush).toHaveBeenCalledWith('/session/session-1/message/tool%3Acall%3Aparent%2F1?jumpChildId=tool%3Acall%3Achild%2F2');
    });

    it('renders a tool preview when detail level is not title', async () => {
        toolDetailSetting = 'summary';
        mockedToolName = 'edit';
        mockedToolInput = { path: 'file.ts' };
        mockedHeaderText = { normalizedToolName: 'edit', title: 'Edit', subtitle: null, statusText: null };
        const { PermissionPromptCard } = await import('./PermissionPromptCard');

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderScreen(<PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        expect(screen.findByTestId('permission-prompt-tool-inline-body')).toBeTruthy();
    });

    it('hides the tool preview when detail level is title', async () => {
        toolDetailSetting = 'title';
        mockedToolName = 'edit';
        mockedToolInput = { path: 'file.ts' };
        mockedHeaderText = { normalizedToolName: 'edit', title: 'Edit', subtitle: null, statusText: null };
        const { PermissionPromptCard } = await import('./PermissionPromptCard');

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderScreen(<PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        expect(screen.findByTestId('permission-prompt-tool-inline-body')).toBeNull();
    });

    it('hides the tool preview when detail level is compact', async () => {
        toolDetailSetting = 'compact';
        mockedToolName = 'edit';
        mockedToolInput = { path: 'file.ts' };
        mockedHeaderText = { normalizedToolName: 'edit', title: 'Edit', subtitle: null, statusText: null };
        const { PermissionPromptCard } = await import('./PermissionPromptCard');

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderScreen(<PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        expect(screen.findByTestId('permission-prompt-tool-inline-body')).toBeNull();
    });

    it('does not repeat a shell command subtitle when a preview is visible', async () => {
        toolDetailSetting = 'summary';
        mockedToolName = 'Bash';
        mockedToolInput = { command: 'COMMAND_SUBTITLE' };
        mockedHeaderText = { normalizedToolName: 'Bash', title: 'Run command', subtitle: 'COMMAND_SUBTITLE', statusText: null };
        const { PermissionPromptCard } = await import('./PermissionPromptCard');

        const request = { id: 'perm1', tool: 'Bash', arguments: { command: 'COMMAND_SUBTITLE' } } as PendingPermissionRequest;

        const screen = await renderScreen(<PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        const texts = screen.findAllByType('Text' as any);
        const flattened = texts
            .map((t) => t.props.children)
            .flat()
            .filter((c) => typeof c === 'string') as string[];

        expect(flattened).not.toContain('COMMAND_SUBTITLE');
        expect(screen.findByTestId('permission-prompt-tool-inline-body')).toBeTruthy();
    });
});
