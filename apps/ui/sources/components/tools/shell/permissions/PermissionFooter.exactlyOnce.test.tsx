import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

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
            Platform: { OS: 'web' },
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

describe('PermissionFooter exactly-once actions', () => {
    beforeEach(() => {
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

    it('admits only the first same-turn approve, deny, or session-approve action', async () => {
        const { PermissionFooter } = await import('./PermissionFooter');
        const cases = [
            {
                firstTestID: 'permission-footer.allow',
                expectedOperation: ops.sessionAllow,
                expectedArgs: ['session-1', 'permission-1', undefined, undefined, 'approved'],
            },
            {
                firstTestID: 'permission-footer.deny',
                expectedOperation: ops.sessionDeny,
                expectedArgs: ['session-1', 'permission-1', undefined, undefined, 'denied'],
            },
            {
                firstTestID: 'permission-footer.allow-for-session',
                expectedOperation: ops.sessionAllow,
                expectedArgs: ['session-1', 'permission-1', undefined, undefined, 'approved_for_session'],
            },
        ] as const;

        for (const testCase of cases) {
            ops.sessionAllow.mockClear();
            ops.sessionDeny.mockClear();
            const pendingOperation = createDeferred<void>();
            testCase.expectedOperation.mockReturnValueOnce(pendingOperation.promise);
            const screen = await renderScreen(
                <PermissionFooter
                    permission={{ id: 'permission-1', status: 'pending' }}
                    sessionId="session-1"
                    toolName="execute"
                    metadata={{ flavor: 'codex' }}
                />,
            );
            const firstAction = screen.findByProps({ testID: testCase.firstTestID });
            const competingActions = [
                screen.findByProps({ testID: 'permission-footer.allow' }),
                screen.findByProps({ testID: 'permission-footer.deny' }),
                screen.findByProps({ testID: 'permission-footer.allow-for-session' }),
            ];

            let firstPress!: Promise<void>;
            act(() => {
                firstPress = firstAction.props.onPress();
                firstAction.props.onPress();
                for (const competingAction of competingActions) {
                    competingAction.props.onPress();
                }
            });

            expect(ops.sessionAllow.mock.calls.length + ops.sessionDeny.mock.calls.length).toBe(1);
            expect(testCase.expectedOperation).toHaveBeenCalledWith(...testCase.expectedArgs);

            pendingOperation.resolve();
            await act(async () => {
                await firstPress;
            });
            await screen.unmount();
        }
    });

    it('scopes admission and settlement to the current permission request identity', async () => {
        const oldApproval = createDeferred<void>();
        const currentDenial = createDeferred<void>();
        ops.sessionAllow.mockReturnValueOnce(oldApproval.promise);
        ops.sessionDeny.mockReturnValueOnce(currentDenial.promise);

        const { PermissionFooter } = await import('./PermissionFooter');
        const renderFooter = (permissionId: string) => (
            <PermissionFooter
                permission={{ id: permissionId, status: 'pending' }}
                sessionId="session-1"
                toolName="execute"
                metadata={{ flavor: 'codex' }}
            />
        );
        const screen = await renderScreen(renderFooter('permission-1'));

        let oldApprovalPress!: Promise<void>;
        act(() => {
            oldApprovalPress = screen.findByProps({ testID: 'permission-footer.allow' }).props.onPress();
        });

        await screen.update(renderFooter('permission-2'));
        const currentDeny = screen.findByProps({ testID: 'permission-footer.deny' });
        expect(currentDeny.props.accessibilityState).toEqual({
            disabled: false,
            selected: false,
            busy: false,
        });

        let currentDenyPress!: Promise<void>;
        act(() => {
            currentDenyPress = currentDeny.props.onPress();
        });
        expect(ops.sessionAllow).toHaveBeenCalledTimes(1);
        expect(ops.sessionDeny).toHaveBeenCalledTimes(1);

        oldApproval.reject(new Error('stale permission failure'));
        await act(async () => {
            await oldApprovalPress;
        });
        expect(screen.findAllByProps({ testID: 'permission-footer.action-error' })).toHaveLength(0);
        expect(screen.findByProps({ testID: 'permission-footer.deny' }).props.accessibilityState).toEqual({
            disabled: true,
            selected: false,
            busy: true,
        });

        currentDenial.resolve();
        await act(async () => {
            await currentDenyPress;
        });

        const unmountedApproval = createDeferred<void>();
        ops.sessionAllow.mockReturnValueOnce(unmountedApproval.promise);
        await screen.update(renderFooter('permission-3'));
        let unmountedApprovalPress!: Promise<void>;
        act(() => {
            unmountedApprovalPress = screen.findByProps({ testID: 'permission-footer.allow' }).props.onPress();
        });
        await screen.unmount();
        unmountedApproval.reject(new Error('settled after unmount'));
        await act(async () => {
            await unmountedApprovalPress;
        });

        expect(ops.sessionAllow).toHaveBeenCalledTimes(2);
        expect(ops.sessionDeny).toHaveBeenCalledTimes(1);
    });
});
