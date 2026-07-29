import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

const platformEnvironment = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'android',
}));

installPermissionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            Platform: {
                get OS() {
                    return platformEnvironment.platform;
                },
                select: <T,>(values: { web?: T; android?: T; default?: T }) =>
                    values[platformEnvironment.platform] ?? values.default,
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            importOriginal,
            useSetting: (key: string) => key === 'toolViewDetailLevelDefault' ? 'title' : null,
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('PermissionPromptCard interactive targets', () => {
    beforeEach(() => {
        platformEnvironment.platform = 'web';
        standardCleanup();
    });

    it.each([
        { platform: 'web', minimumSize: 44 },
        { platform: 'android', minimumSize: 48 },
    ] as const)(
        'keeps the View Tool hit target at least $minimumSize on $platform without enlarging its icon',
        async ({ platform, minimumSize }) => {
            platformEnvironment.platform = platform;
            const { PermissionPromptCard } = await import('./PermissionPromptCard');
            const request = {
                id: 'permission-1',
                tool: 'Edit',
                arguments: { path: 'file.ts' },
            } as PendingPermissionRequest;
            const screen = await renderScreen(
                <PermissionPromptCard
                    request={request}
                    location={{
                        kind: 'nested',
                        parentMessageId: 'tool:call:parent/1',
                        messageId: 'tool:call:child/2',
                        seq: 12,
                    }}
                    sessionId="session-1"
                    metadata={null}
                    canApprovePermissions
                />,
            );

            const viewToolAction = screen.findByTestId('permission-prompt-view-tool');
            expect(viewToolAction).toBeTruthy();
            if (!viewToolAction) {
                throw new Error('Expected the View Tool action to be rendered');
            }
            expect(flattenStyle(viewToolAction.props.style)).toMatchObject({
                minWidth: minimumSize,
                minHeight: minimumSize,
            });
            expect(viewToolAction.findByType('Ionicons' as any).props.size).toBe(18);
        },
    );
});
