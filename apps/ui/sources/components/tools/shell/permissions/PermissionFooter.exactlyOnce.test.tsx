import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, standardCleanup } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks, createPermissionShellRenderer } from './permissionShellTestHelpers';

const ops = vi.hoisted(() => ({
    approve: vi.fn(async (..._args: unknown[]) => {}),
    approveWithUpdates: vi.fn(async (..._args: unknown[]) => {}),
    deny: vi.fn(async (..._args: unknown[]) => {}),
    abort: vi.fn(async (..._args: unknown[]) => {}),
}));
const renderScreen = createPermissionShellRenderer(ops);


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

// Collect the real component after the canonical platform mocks are installed;
// module transformation is setup, not elapsed permission-decision behavior.
const { PermissionFooter } = await import('./PermissionFooter');

describe('PermissionFooter exactly-once actions', () => {
    beforeEach(() => {
        ops.approve.mockReset();
        ops.approve.mockResolvedValue(undefined);
        ops.approveWithUpdates.mockReset();
        ops.approveWithUpdates.mockResolvedValue(undefined);
        ops.deny.mockReset();
        ops.deny.mockResolvedValue(undefined);
        ops.abort.mockReset();
        ops.abort.mockResolvedValue(undefined);
        standardCleanup();
    });

    it('admits only the first same-turn approve, deny, or session-approve action', async () => {
        const cases = [
            {
                firstTestID: 'permission-footer.allow',
                expectedOperation: ops.approve,
                expectedArgs: [{ id: 'permission-1', approved: true, decision: 'approved' }],
            },
            {
                firstTestID: 'permission-footer.deny',
                expectedOperation: ops.deny,
                expectedArgs: [{ id: 'permission-1', approved: false, decision: 'denied' }],
            },
            {
                firstTestID: 'permission-footer.allow-for-session',
                expectedOperation: ops.approve,
                expectedArgs: [{ id: 'permission-1', approved: true, decision: 'approved_for_session' }],
            },
        ] as const;

        for (const testCase of cases) {
            ops.approve.mockClear();
            ops.deny.mockClear();
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

            expect(ops.approve.mock.calls.length + ops.deny.mock.calls.length).toBe(1);
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
        ops.approve.mockReturnValueOnce(oldApproval.promise);
        ops.deny.mockReturnValueOnce(currentDenial.promise);

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
        expect(ops.approve).toHaveBeenCalledTimes(1);
        expect(ops.deny).toHaveBeenCalledTimes(1);

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
        ops.approve.mockReturnValueOnce(unmountedApproval.promise);
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

        expect(ops.approve).toHaveBeenCalledTimes(2);
        expect(ops.deny).toHaveBeenCalledTimes(1);
    });
});
