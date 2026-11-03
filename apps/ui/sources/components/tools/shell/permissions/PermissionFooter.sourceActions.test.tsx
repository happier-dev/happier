import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestSessionTranscriptSource, pressTestInstanceAsync, renderWithSessionTranscriptSource, renderScreen, renderHook, wrapWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import type { RenderWithAppProvidersOptions } from '@/dev/testkit';
import { markPendingNavigationTranscriptReady, markSessionPendingAnswer, setPendingNavigationLanding, usePendingNavigationLanding } from '@/activity/source/pendingNavigationRuntime';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';

const nativeFocusBoundary = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'android',
    findNodeHandle: vi.fn(() => 23),
    setAccessibilityFocus: vi.fn(),
}));

function hasHostTestId(element: Parameters<NonNullable<RenderWithAppProvidersOptions['createNodeMock']>>[0], testID: string): boolean {
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
const { resolveSessionPermissionBehavior } = await import('@/sync/ops/sessionPermissionAnswers');
const { resolveSessionPermissionChoices } = await import('@/sync/ops/sessionPermissionChoices');

describe('PermissionFooter source authority', () => {
    it.each(['claude', 'codex'])('renders every canonical choice for a %s Edit request', async (flavor) => {
        const source = createTestSessionTranscriptSource({ sessionId: 's1', agentState: null,
            interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: { respondToPermission: vi.fn(), answerUserAction: vi.fn(), abort: vi.fn(), submitMessage: vi.fn() },
        });
        const metadata = { flavor };
        const choices = resolveSessionPermissionChoices({ toolName: 'Edit',
            permissionBehavior: resolveSessionPermissionBehavior({ agentId: flavor, metadata, accountScope: undefined }) });
        const screen = await renderWithSessionTranscriptSource(<PermissionFooter sessionId="s1"
            permission={{ id: 'edit', status: 'pending' }} toolName="Edit" metadata={metadata} canApprovePermissions />, source);
        const testIDs = choices.map(choice => `permission-footer.${choice.id === 'always_allow' ? 'allow-for-session'
            : choice.id === 'allow_all_edits' ? 'allow-all-edits' : choice.id}`);
        const buttons = screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'button'
            && typeof node.props.onPress === 'function');
        expect(buttons.map(button => button.props.testID)).toEqual(testIDs);
    });
    beforeEach(() => {
        nativeFocusBoundary.platform = 'web';
        nativeFocusBoundary.findNodeHandle.mockClear();
        nativeFocusBoundary.setAccessibilityFocus.mockClear();
    });
    afterEach(standardCleanup);

    it('keeps a native Edit once-only after full AgentState unloads', async () => {
        const projection = reducer(createReducer(), [], AgentStateSchema.parse({ requests: {
            edit: { tool: 'Edit', arguments: { file_path: 'example.ts' }, createdAt: 1,
                turnId: 'native-turn', source: 'native_tool_approval_once' },
        } }));
        const message = projection.messages.find(message => message.kind === 'tool-call');
        if (message?.kind !== 'tool-call' || !message.tool.permission) throw new Error('Missing projected Edit');
        const respondToPermission = vi.fn(async () => {});
        const source = createTestSessionTranscriptSource({ sessionId: 's1', agentState: null,
            interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: { respondToPermission, answerUserAction: vi.fn(), abort: vi.fn(), submitMessage: vi.fn() },
        });
        const screen = await renderWithSessionTranscriptSource(<PermissionFooter sessionId="s1"
            permission={message.tool.permission} toolName="Edit" toolInput={message.tool.input}
            metadata={{ flavor: 'claude' }} canApprovePermissions />, source);
        const choices = screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'button'
            && typeof node.props.onPress === 'function');
        expect(choices.filter(node => !['permission-footer.allow', 'permission-footer.deny', 'permission-footer.stop']
            .includes(node.props.testID))).toHaveLength(0);
        await screen.pressByTestIdAsync('permission-footer.allow');
        expect(respondToPermission).toHaveBeenCalledWith({ id: 'edit', approved: true, turnId: 'native-turn' });
    });

    it.each([
        { flavor: 'claude', tool: 'Bash', arguments: { command: 'git status' } },
        { flavor: 'claude', tool: 'Edit', arguments: { file_path: 'example.ts' } },
        { flavor: 'codex', tool: 'Bash', arguments: { command: 'git status', proposedExecpolicyAmendment: ['git', 'status'] } },
    ])('offers no reusable grant for a host-admitted once-only $flavor $tool request', async ({ flavor, tool, arguments: toolInput }) => {
        const respondToPermission = vi.fn(async () => {});
        const source = createTestSessionTranscriptSource({ sessionId: 's1',
            agentState: { requests: { p1: { tool, arguments: toolInput, source: 'native_tool_approval_once' } } },
            interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: { respondToPermission, answerUserAction: vi.fn(), abort: vi.fn(), submitMessage: vi.fn() },
        });
        const screen = await renderWithSessionTranscriptSource(<PermissionFooter sessionId="s1"
            permission={{ id: 'p1', status: 'pending' }} toolName={tool} toolInput={toolInput}
            metadata={{ flavor }} canApprovePermissions />, source);
        const choices = screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'button'
            && typeof node.props.onPress === 'function');
        expect(choices.filter(node => !['permission-footer.allow', 'permission-footer.deny', 'permission-footer.stop']
            .includes(node.props.testID))).toHaveLength(0);
        expect(screen.findHostByTestId('permission-footer.deny')).not.toBeNull();
        await screen.pressByTestIdAsync('permission-footer.allow');
        expect(respondToPermission).toHaveBeenCalledWith({ id: 'p1', approved: true,
            ...(flavor === 'codex' ? { decision: 'approved' } : {}) });
    });

    it('retains reusable choices for a Session request that admits session persistence', async () => {
        const source = createTestSessionTranscriptSource({ sessionId: 's1',
            agentState: { requests: { p1: { tool: 'Bash', arguments: { command: 'git status' } } } },
            interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: { respondToPermission: vi.fn(), answerUserAction: vi.fn(), abort: vi.fn(), submitMessage: vi.fn() },
        });
        const screen = await renderWithSessionTranscriptSource(<PermissionFooter sessionId="s1"
            permission={{ id: 'p1', status: 'pending', source: 'native_tool_approval_once' }} toolName="Bash" toolInput={{ command: 'git status' }}
            metadata={{ flavor: 'claude' }} canApprovePermissions />, source);
        expect(screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'button'
            && typeof node.props.onPress === 'function' && node.props.testID === undefined).length).toBeGreaterThan(0);
    });

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

    it('transfers focus from the prompt to the revealed transcript answer and ignores a late answered landing', async () => {
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
        setPendingNavigationLanding(address, 'p1');
        const intent = await renderHook(() => usePendingNavigationLanding(address));
        const expectedLanding = intent.getCurrent()!;
        let answerControlIndex = 0;
        await renderScreen(wrapWithSessionTranscriptSource(controls, source), {
            createNodeMock: (element) => hasHostTestId(element, 'permission-footer.allow')
                ? { focus: answerControlIndex++ === 0 ? promptFocus : transcriptFocus } : null,
        });
        expect(promptFocus).toHaveBeenCalledOnce();
        expect(transcriptFocus).not.toHaveBeenCalled();
        await React.act(async () => { markPendingNavigationTranscriptReady(expectedLanding); });
        expect(promptFocus).toHaveBeenCalledOnce();
        expect(transcriptFocus).toHaveBeenCalledOnce();
        expect(respondToPermission).not.toHaveBeenCalled();
        await React.act(async () => { markSessionPendingAnswer(address, 'p1'); markPendingNavigationTranscriptReady(expectedLanding); });
        expect(intent.getCurrent()).toBeNull();
        expect(transcriptFocus).toHaveBeenCalledOnce();
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
