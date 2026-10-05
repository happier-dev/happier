import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestSessionTranscriptSource, pressTestInstanceAsync, renderWithSessionTranscriptSource, renderScreen, wrapWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { setPendingNavigationLanding } from '@/activity/source/pendingNavigationRuntime';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

const nativeFocusBoundary = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'android',
    findNodeHandle: vi.fn(() => 23),
    setAccessibilityFocus: vi.fn(),
}));

function hasHostTestId(element: React.ReactElement, testID: string): boolean {
    if (React.isValidElement<{ testID?: string }>(element)) return element.props.testID === testID;
    // react-test-renderer may pass a plain native host descriptor to createNodeMock.
    const props: unknown = element.props;
    return props !== null && typeof props === 'object' && 'testID' in props && props.testID === testID;
}

installPermissionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() { return nativeFocusBoundary.platform; },
                select: <T,>(values: { web?: T; android?: T; native?: T; default?: T }) =>
                    values[nativeFocusBoundary.platform] ?? values.native ?? values.default,
            },
            findNodeHandle: nativeFocusBoundary.findNodeHandle,
            AccessibilityInfo: { setAccessibilityFocus: nativeFocusBoundary.setAccessibilityFocus },
        });
    },
});

// Install the platform boundary before the actual owner captures its React Native imports.
const { PermissionFooter } = await import('./PermissionFooter');

describe('PermissionFooter source authority', () => {
    beforeEach(() => {
        nativeFocusBoundary.platform = 'web';
        nativeFocusBoundary.findNodeHandle.mockClear();
        nativeFocusBoundary.setAccessibilityFocus.mockClear();
    });
    afterEach(standardCleanup);

    it('accessibility-focuses a native primary choice even when its host exposes a no-op focus method', async () => {
        nativeFocusBoundary.platform = 'android';
        const native = await import('react-native');
        expect(native.Platform.OS).toBe('android');
        expect(native.findNodeHandle).toBe(nativeFocusBoundary.findNodeHandle);
        const address = { serverId: 'home-a', sessionId: 's1' };
        const respondToPermission = vi.fn(async () => {});
        // RN 0.83 non-text host refs expose focus(), which is a no-op with OSS defaults.
        const host = { focus: vi.fn(() => {}) };
        setPendingNavigationLanding(address, 'p1');
        const source = createTestSessionTranscriptSource({ ...address,
            interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: { respondToPermission, answerUserAction: vi.fn(), abort: vi.fn(), submitMessage: vi.fn() },
        });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(
            <PermissionFooter sessionId="s1" permission={{ id: 'p1', status: 'pending' }} toolName="Read"
                metadata={{ flavor: 'claude' }} canApprovePermissions />, source,
        ), { createNodeMock: (element) => hasHostTestId(element, 'permission-footer.allow') ? host : null });
        expect(screen.findHostByTestId('permission-footer.allow')).toBeTruthy();
        expect(host.focus).toHaveBeenCalledOnce();
        expect(nativeFocusBoundary.findNodeHandle).toHaveBeenCalledWith(host);
        expect(nativeFocusBoundary.setAccessibilityFocus).toHaveBeenCalledExactlyOnceWith(23);
        expect(respondToPermission).not.toHaveBeenCalled();
    });

    it('focuses only the selected placement when transcript and composer controls coexist', async () => {
        const address = { serverId: 'home-a', sessionId: 's1' };
        const promptFocus = vi.fn();
        const transcriptFocus = vi.fn();
        const respondToPermission = vi.fn(async () => {});
        const source = createTestSessionTranscriptSource({ ...address,
            interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: { respondToPermission, answerUserAction: vi.fn(), abort: vi.fn(), submitMessage: vi.fn() },
        });
        const controls = <>
            <PermissionFooter sessionId="s1" permission={{ id: 'p1', status: 'pending' }} toolName="Read"
                metadata={{ flavor: 'claude' }} canApprovePermissions />
            <PermissionFooter sessionId="s1" messageId="message-1" permission={{ id: 'p1', status: 'pending' }} toolName="Read"
                metadata={{ flavor: 'claude' }} canApprovePermissions />
        </>;
        setPendingNavigationLanding(address, 'p1', 'pending', 'transcript');
        let answerControlIndex = 0;
        await renderScreen(wrapWithSessionTranscriptSource(controls, source), {
            createNodeMock: (element) => hasHostTestId(element, 'permission-footer.allow')
                ? { focus: answerControlIndex++ === 0 ? promptFocus : transcriptFocus } : null,
        });
        expect(promptFocus).not.toHaveBeenCalled();
        expect(transcriptFocus).toHaveBeenCalledOnce();
        expect(respondToPermission).not.toHaveBeenCalled();
    });

    it('focuses the mounted Next target primary answer without answering and ignores another Home', async () => {
        const respondToPermission = vi.fn(async () => {});
        const focus = vi.fn();
        setPendingNavigationLanding({ serverId: 'home-a', sessionId: 's1' }, 'p1');
        const source = createTestSessionTranscriptSource({
            sessionId: 's1', serverId: 'home-b',
            interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: { respondToPermission, answerUserAction: vi.fn(), abort: vi.fn(), submitMessage: vi.fn() },
        });
        const footer = <PermissionFooter sessionId="s1" permission={{ id: 'p1', status: 'pending' }} toolName="Read"
            metadata={{ flavor: 'claude' }} canApprovePermissions />;
        const screen = await renderScreen(wrapWithSessionTranscriptSource(footer, source), {
            createNodeMock: (element) => hasHostTestId(element, 'permission-footer.allow') ? { focus } : null,
        });
        expect(focus).not.toHaveBeenCalled();
        await screen.update(wrapWithSessionTranscriptSource(footer, { ...source, serverId: 'home-a' }));
        expect(focus).toHaveBeenCalledOnce();
        expect(respondToPermission).not.toHaveBeenCalled();
        await screen.update(wrapWithSessionTranscriptSource(footer, { ...source, serverId: 'home-a' }));
        expect(focus).toHaveBeenCalledOnce();
    });

    it('withdraws decision controls when the source has no actions, even if the caller enables approval', async () => {
        const source = createTestSessionTranscriptSource({
            interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: null,
        });
        const screen = await renderWithSessionTranscriptSource(
            <PermissionFooter sessionId="s1" permission={{ id: 'p1', status: 'pending' }} toolName="Read"
                metadata={{ flavor: 'claude' }} canApprovePermissions />,
            source,
        );
        expect(screen.findAllByProps({ testID: 'permission-footer.allow' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'permission-footer.deny' })).toHaveLength(0);
    });

    it('keeps execution-run responses with the run when session actions exist', async () => {
        const respondToPermission = vi.fn(async () => {});
        const respond = vi.fn(async () => {});
        const source = createTestSessionTranscriptSource({
            interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: { respondToPermission, answerUserAction: vi.fn(), abort: vi.fn(), submitMessage: vi.fn() },
        });
        const screen = await renderWithSessionTranscriptSource(
            <PermissionFooter executionRun={{ executionRunId: 'run1', respond, pendingRequestIds: new Set() }}
                permission={{ id: 'run-request', status: 'pending' }} toolName="Read" canApprovePermissions />,
            source,
        );
        await pressTestInstanceAsync(screen.findByProps({ testID: 'permission-footer.allow' }), 'run allow');
        expect(respond).toHaveBeenCalledWith({ requestId: 'run-request', approved: true });
        expect(respondToPermission).not.toHaveBeenCalled();
    });

    it('withdraws session answers when the interaction forbids approval despite an action carrier', async () => {
        const respondToPermission = vi.fn(async () => {});
        const screen = await renderWithSessionTranscriptSource(
            <PermissionFooter sessionId="s1" permission={{ id: 'p1', status: 'pending' }} toolName="Read"
                metadata={{ flavor: 'claude' }} canApprovePermissions />,
            createTestSessionTranscriptSource({
                interaction: { canSendMessages: true, canApprovePermissions: false },
                actions: { respondToPermission, answerUserAction: vi.fn(), abort: vi.fn(), submitMessage: vi.fn() },
            }),
        );
        expect(screen.findAllByProps({ testID: 'permission-footer.allow' })).toHaveLength(0);
        expect(respondToPermission).not.toHaveBeenCalled();
    });
});
