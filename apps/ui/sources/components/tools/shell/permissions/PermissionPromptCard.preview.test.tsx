import { renderWithSessionTranscriptSource as renderBoundScreen, createTestSessionTranscriptSource } from '@/dev/testkit';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { pressTestInstanceAsync } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const routerPush = vi.fn();
function renderWithSessionTranscriptSource(element: React.ReactElement) {
    return renderBoundScreen(<AppPaneProvider>{element}</AppPaneProvider>,
        createTestSessionTranscriptSource({ sessionId: 'session-1', navigate: routerPush }));
}
let toolDetailSetting: 'summary' | 'title' | 'compact' = 'summary';

installPermissionShellCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        // A distinctive part radius proves the component reads the theme's part token, not a constant.
        return createUnistylesMock({ theme: { parts: { approvalCard: { radius: 37 } } } });
    },
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

// Load the real prompt graph during collection, before any render/act lifecycle begins.
const [{ PermissionPromptCard }, { ToolInlineBody }, { AppPaneProvider }] = await Promise.all([
    import('./PermissionPromptCard'),
    import('@/components/tools/shell/views/ToolInlineBody'),
    import('@/components/appShell/panes/AppPaneProvider'),
]);
// React's test renderer exposes the render function inside a memo boundary.
const InlineBody = (ToolInlineBody as React.MemoExoticComponent<React.ComponentType<React.ComponentProps<typeof ToolInlineBody>>>).type;

describe('PermissionPromptCard (preview)', () => {
    it('marks an agent\'s pending ask as needing this person only when they can answer it', async () => {
        const request = { id: 'perm-tone', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;
        const toneFor = async (canApprovePermissions: boolean) => {
            const screen = await renderWithSessionTranscriptSource(<PermissionPromptCard request={request}
                location={{ kind: 'top', messageId: 'tone', seq: null }} sessionId="session-1" metadata={null}
                canApprovePermissions={canApprovePermissions} />);
            // The chrome element is the one carrying the card's testID and its tone.
            return screen.tree.root.findAll((node) => node.props.testID === 'permission-prompt-card' && 'tone' in node.props)[0]?.props.tone;
        };
        expect(await toneFor(true)).toBe('attention');
        expect(await toneFor(false)).not.toBe('attention');
    });

    it('rounds the card with the theme approval card radius', async () => {
        toolDetailSetting = 'summary';

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderWithSessionTranscriptSource(<PermissionPromptCard
                    request={request}
                    location={{ kind: 'top', messageId: 'v0k1hmbmnud', seq: null }}
                    sessionId="session-1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        expect(findStyledNodes(screen.tree.root, 'borderRadius', 37).length).toBeGreaterThan(0);
    });

    it('hides the open-details action when the prompt location is not durably addressable', async () => {
        toolDetailSetting = 'summary';

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderWithSessionTranscriptSource(<PermissionPromptCard
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
        routerPush.mockReset();

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderWithSessionTranscriptSource(<PermissionPromptCard
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

        await pressTestInstanceAsync(viewToolButton, 'permission-prompt-view-tool');

        expect(routerPush).toHaveBeenCalledWith('/session/session-1/message/tool%3Acall%3Aparent%2F1?jumpChildId=tool%3Acall%3Achild%2F2');
    });

    it('renders a tool preview when detail level is not title', async () => {
        toolDetailSetting = 'summary';

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderWithSessionTranscriptSource(<PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        expect(screen.tree.root.findAllByType(InlineBody)).toHaveLength(1);
    });

    it('hides the tool preview when detail level is title', async () => {
        toolDetailSetting = 'title';

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderWithSessionTranscriptSource(<PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        expect(screen.tree.root.findAllByType(InlineBody)).toHaveLength(0);
    });

    it('hides the tool preview when detail level is compact', async () => {
        toolDetailSetting = 'compact';

        const request = { id: 'perm1', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderWithSessionTranscriptSource(<PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        expect(screen.tree.root.findAllByType(InlineBody)).toHaveLength(0);
    });

    it.each([
        ['Bash', 'Run command', { command: 'COMMAND_SUBTITLE' }],
        ['AskUserQuestion', 'Question', { questions: [{ question: 'COMMAND_SUBTITLE', options: [] }] }],
    ])('does not repeat a %s subtitle the visible preview already shows', async (toolName, title, input) => {
        toolDetailSetting = 'summary';

        const request = { id: 'perm1', tool: toolName, arguments: input } as PendingPermissionRequest;

        const screen = await renderWithSessionTranscriptSource(<PermissionPromptCard
                    request={request}
                    location={null}
                    sessionId="s1"
                    metadata={null}
                    canApprovePermissions={true}
                />);

        const headers = screen.tree.root.findAll(node => node.props.testID === 'permission-prompt-card'
            && Object.hasOwn(node.props, 'subtitle'));
        expect(headers.length).toBeGreaterThan(0);
        expect(headers.every(node => node.props.subtitle === null)).toBe(true);
        expect(screen.tree.root.findAllByType(InlineBody)).toHaveLength(1);
    });

    it('does not render when the session is inactive', async () => {
        toolDetailSetting = 'summary';

        const request = { id: 'perm-inactive', tool: 'edit', arguments: { path: 'file.ts' } } as PendingPermissionRequest;

        const screen = await renderWithSessionTranscriptSource(
            <PermissionPromptCard
                request={request}
                location={null}
                sessionId="session-1"
                metadata={null}
                canApprovePermissions={true}
                disabledReason="inactive"
            />,
        );

        expect(screen.findAllByTestId('permission-prompt-card')).toHaveLength(0);
    });
});

function findStyledNodes(root: { findAll: (predicate: (node: any) => boolean) => any[] }, key: string, value: unknown) {
    const flatten = (style: unknown): Record<string, unknown> => {
        if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
        return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
    };
    return root.findAll((node) => typeof node.type === 'string' && flatten(node.props?.style)[key] === value);
}
