import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createReactNativeAppStateEmitter } from '@/dev/testkit/mocks/reactNative';
import { AppState } from 'react-native';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@hugeicons/react-native', () => ({
    HugeiconsIcon: (props: Record<string, unknown>) => React.createElement('HugeiconsIcon', props),
}));

import { SessionUsageLimitRecoveryBanner } from './SessionUsageLimitRecoveryBanner';

describe('overload recovery countdown', () => {
    const appState = createReactNativeAppStateEmitter();
    let restoreAppState: (() => void) | null = null;
    beforeAll(() => { restoreAppState = appState.install(AppState); });
    afterAll(() => { restoreAppState?.(); });
    afterEach(async () => { await act(async () => { appState.emit('active'); }); vi.useRealTimers(); });
    it('shows the typed quota cause and reset, opens account recovery, and discloses the request ID only under Details', async () => {
        const runtimeIssue = SessionRuntimeIssueV1Schema.parse({
            v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
            agentId: 'codex', occurredAt: 1_700_000_000_000, sanitizedPreview: 'Usage limit reached',
            failureCause: { phase: 'turn', failureReason: 'usage_limit', providerErrorCode: 'UsageLimitExceeded',
                requestId: 'req-session-quota-fixture', retryable: false },
            usageLimit: { v: 1, recoverability: 'wait', quotaScope: 'account', resetAtMs: 1_794_056_400_000,
                retryAfterMs: null, connectedService: { serviceId: 'openai-codex', profileId: 'exhausted-profile', groupId: null } },
        });
        const openAccountSwitcher = vi.fn();
        const screen = await renderScreen(<SessionUsageLimitRecoveryBanner testID="recovery" surfaceFocused
            title="Usage limit" body="Wait and resume" runtimeIssue={runtimeIssue} onUseAnotherAccount={openAccountSwitcher} />);
        expect(screen.getTextContent()).toContain('resets');
        expect(screen.getTextContent()).not.toContain('req-session-quota-fixture');
        await act(async () => { screen.pressByTestId('recovery-switch-account'); });
        expect(openAccountSwitcher).toHaveBeenCalledOnce();
        expect(screen.findByTestId('recovery-details-toggle')?.props.accessibilityState).toMatchObject({ expanded: false });
        await act(async () => { screen.pressByTestId('recovery-details-toggle'); });
        expect(screen.getTextContent()).toContain('req-session-quota-fixture');
        expect(screen.getTextContent()).toContain('UsageLimitExceeded');
        expect(screen.findByTestId('recovery-details-code')?.props.selectable).toBe(true);
        await act(async () => { screen.tree.update(<SessionUsageLimitRecoveryBanner testID="recovery" surfaceFocused
            title="Usage limit" body="Switch accounts" runtimeIssue={runtimeIssue}
            actionTestID="recovery-primary" actionLabel="Switch account now" onActionPress={vi.fn()}
            accountRecoveryIsPrimary onUseAnotherAccount={openAccountSwitcher} />); });
        expect(screen.findByTestId('recovery-switch-account')).toBeNull();
        await act(async () => { screen.pressByTestId('recovery-primary'); });
        expect(openAccountSwitcher).toHaveBeenCalledTimes(2);
    });
    it('offers the Session\'s account recovery itself and does not repeat a generic runtime preview', async () => {
        const runtimeIssue = SessionRuntimeIssueV1Schema.parse({
            v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
            agentId: 'claude', occurredAt: 1_700_000_000_000, sanitizedPreview: 'Session runtime failed',
            usageLimit: { v: 1, recoverability: 'wait', quotaScope: 'account', resetAtMs: 1_794_056_400_000, retryAfterMs: null },
        });
        const openAccountSwitcher = vi.fn();
        const screen = await renderScreen(<SessionUsageLimitRecoveryBanner testID="recovery" surfaceFocused
            title="Usage limit reached" body="Wait and resume" runtimeIssue={runtimeIssue}
            deliveryRecovery="choose_account" onUseAnotherAccount={openAccountSwitcher} />);
        expect(screen.getTextContent()).not.toContain('Session runtime failed');
        await act(async () => { screen.pressByTestId('recovery-switch-account'); });
        expect(openAccountSwitcher).toHaveBeenCalledOnce();
    });
    it('updates only the banner leaf and removes its timer when no scheduled retry remains', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        let parentRenders = 0;
        function Parent({ deadline, focused = true }: { deadline: number | null; focused?: boolean }) {
            parentRenders += 1;
            return <SessionUsageLimitRecoveryBanner testID="recovery" title="Model overloaded" body="Waiting"
                surfaceFocused={focused} temporaryThrottle={{ nextCheckAtMs: deadline, attemptCount: 2 }} />;
        }
        const screen = await renderScreen(<Parent deadline={Date.now() + 12_000} />);
        expect(screen.getTextContent()).toContain('12 seconds');
        expect(screen.getTextContent()).toContain('attempt 3');
        const parentBeforeTick = parentRenders;
        await act(async () => { vi.advanceTimersByTime(3_000); });
        expect(screen.getTextContent()).toContain('9 seconds');
        expect(parentRenders).toBe(parentBeforeTick);
        await act(async () => { appState.emit('background'); });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { appState.emit('active'); });
        await act(async () => { screen.tree.update(<Parent deadline={null} />); });
        expect(screen.getTextContent()).not.toContain('seconds');
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { screen.tree.update(<Parent deadline={Date.now() + 12_000} focused={false} />); });
        expect(vi.getTimerCount()).toBe(0);
    });
});
