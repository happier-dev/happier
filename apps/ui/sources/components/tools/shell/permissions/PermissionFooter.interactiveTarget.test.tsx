import * as React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

const platformEnvironment = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'android',
}));

const ops = vi.hoisted(() => ({
    sessionAllow: vi.fn(async (..._args: unknown[]) => {}),
    sessionAllowWithPermissionUpdates: vi.fn(async (..._args: unknown[]) => {}),
    sessionDeny: vi.fn(async (..._args: unknown[]) => {}),
    sessionAbort: vi.fn(async (..._args: unknown[]) => {}),
}));

installPermissionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            TouchableOpacity: 'TouchableOpacity',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                get OS() {
                    return platformEnvironment.platform;
                },
                select: <T,>(values: { web?: T; android?: T; default?: T }) =>
                    values[platformEnvironment.platform] ?? values.default,
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: ops.sessionAllow,
    sessionAllowWithPermissionUpdates: ops.sessionAllowWithPermissionUpdates,
    sessionDeny: ops.sessionDeny,
    sessionAbort: ops.sessionAbort,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function expectMinimumActionTarget(button: ReactTestInstance, minimumSize: 44 | 48) {
    expect(flattenStyle(button.props.style)).toMatchObject({
        minWidth: minimumSize,
        minHeight: minimumSize,
    });
}

describe('PermissionFooter interactive targets', () => {
    beforeEach(() => {
        platformEnvironment.platform = 'web';
        ops.sessionAllow.mockReset();
        ops.sessionAllow.mockResolvedValue(undefined);
        ops.sessionAllowWithPermissionUpdates.mockReset();
        ops.sessionAllowWithPermissionUpdates.mockResolvedValue(undefined);
        ops.sessionDeny.mockReset();
        ops.sessionDeny.mockResolvedValue(undefined);
        ops.sessionAbort.mockReset();
        ops.sessionAbort.mockResolvedValue(undefined);
        standardCleanup();
    });

    it.each([
        { platform: 'web', minimumSize: 44 },
        { platform: 'android', minimumSize: 48 },
    ] as const)(
        'keeps every Codex decision action at least $minimumSize on $platform',
        async ({ platform, minimumSize }) => {
            platformEnvironment.platform = platform;
            const { PermissionFooter } = await import('./PermissionFooter');
            const screen = await renderScreen(
                <PermissionFooter
                    permission={{ id: 'permission-1', status: 'pending' }}
                    sessionId="session-1"
                    toolName="execute"
                    toolInput={{ proposed_execpolicy_amendment: ['allow', 'read'] }}
                    metadata={{ flavor: 'codex' }}
                />,
            );

            const actions = screen.findAllByType('TouchableOpacity' as any);
            expect(actions).toHaveLength(5);
            for (const action of actions) {
                expectMinimumActionTarget(action, minimumSize);
            }
        },
    );

    it.each([
        { platform: 'web', minimumSize: 44 },
        { platform: 'android', minimumSize: 48 },
    ] as const)(
        'keeps every standard permission action at least $minimumSize on $platform',
        async ({ platform, minimumSize }) => {
            platformEnvironment.platform = platform;
            const { PermissionFooter } = await import('./PermissionFooter');
            const screen = await renderScreen(
                <PermissionFooter
                    permission={{ id: 'permission-1', status: 'pending' }}
                    sessionId="session-1"
                    toolName="Bash"
                    toolInput={{ command: 'git status' }}
                    metadata={{ flavor: 'claude' }}
                />,
            );

            const actions = screen.findAllByType('TouchableOpacity' as any);
            expect(actions.length).toBeGreaterThanOrEqual(3);
            for (const action of actions) {
                expectMinimumActionTarget(action, minimumSize);
            }
        },
    );

    it.each([
        {
            protocol: 'Codex',
            toolName: 'execute',
            toolInput: { proposed_execpolicy_amendment: ['allow', 'read'] },
            metadata: { flavor: 'codex' },
            approvedPermission: {
                id: 'permission-1',
                status: 'approved',
                decision: 'approved',
            } as const,
        },
        {
            protocol: 'standard',
            toolName: 'Bash',
            toolInput: { command: 'git status' },
            metadata: { flavor: 'claude' },
            approvedPermission: {
                id: 'permission-1',
                status: 'approved',
            } as const,
        },
    ])(
        'exposes truthful button, disabled, selected, and busy semantics for $protocol actions',
        async ({ toolName, toolInput, metadata, approvedPermission }) => {
            const approval = createDeferred<void>();
            ops.sessionAllow.mockImplementationOnce(() => approval.promise);
            const { PermissionFooter } = await import('./PermissionFooter');
            const renderFooter = (permission: {
                id: string;
                status: 'pending' | 'approved' | 'denied';
                decision?: 'approved' | 'denied';
            }) => (
                <PermissionFooter
                    permission={permission}
                    sessionId="session-1"
                    toolName={toolName}
                    toolInput={toolInput}
                    metadata={metadata}
                />
            );
            const screen = await renderScreen(renderFooter({
                id: 'permission-1',
                status: 'pending',
            }));

            for (const action of screen.findAllByType('TouchableOpacity' as any)) {
                expect(action.props.accessibilityRole).toBe('button');
                expect(action.props.accessibilityState).toEqual({
                    disabled: false,
                    selected: false,
                    busy: false,
                });
            }

            const allow = screen.findByProps({ testID: 'permission-footer.allow' });
            let approvalPromise!: Promise<void>;
            await act(async () => {
                approvalPromise = allow.props.onPress();
            });

            expect(screen.findByProps({ testID: 'permission-footer.allow' }).props.accessibilityState).toEqual({
                disabled: true,
                selected: false,
                busy: true,
            });
            for (const action of screen.findAllByType('TouchableOpacity' as any)) {
                expect(action.props.accessibilityState.disabled).toBe(true);
                if (action.props.testID !== 'permission-footer.allow') {
                    expect(action.props.accessibilityState.busy).toBe(false);
                }
            }

            approval.resolve();
            await act(async () => {
                await approvalPromise;
            });
            await screen.update(renderFooter(approvedPermission));

            expect(screen.findByProps({ testID: 'permission-footer.allow' }).props.accessibilityState).toEqual({
                disabled: true,
                selected: true,
                busy: false,
            });

            await screen.update(renderFooter({
                id: 'permission-1',
                status: 'denied',
                decision: 'denied',
            }));
            expect(screen.findByProps({ testID: 'permission-footer.allow' }).props.accessibilityState.selected).toBe(false);
            expect(screen.findByProps({ testID: 'permission-footer.deny' }).props.accessibilityState).toEqual({
                disabled: true,
                selected: true,
                busy: false,
            });
        },
    );
});
