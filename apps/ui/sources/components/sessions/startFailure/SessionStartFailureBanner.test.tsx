import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

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

import { SessionStartFailureBanner } from './SessionStartFailureBanner';
import { resolveSessionStartFailureNotice } from './sessionStartFailureNotice';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

const notice = {
    code: 'native_agent_privileged_effect_authority_unavailable',
    message: 'Runner daemon authority is unavailable. Check the target Machine, then retry the Session.',
    retryable: true,
};

describe('SessionStartFailureBanner', () => {
    it('opens the existing model picker for a model-required refusal, offering no action without a writable composer', async () => {
        const issue = SessionRuntimeIssueV1Schema.parse({ v: 1, scope: 'primary_session', status: 'failed', occurredAt: 1,
            code: 'agent_startup_model_reconciliation_failed', source: 'agent_session_error',
            failureCause: { phase: 'client_start', failureReason: 'model_selection_required', retryable: false } });
        const refused = resolveSessionStartFailureNotice({ issue, sessionActive: false });
        expect(refused).not.toBeNull();
        const chooseModel = vi.fn();
        const screen = await renderScreen(<SessionStartFailureBanner notice={refused!}
            retry={{ run: vi.fn(), busy: false }} chooseModel={chooseModel} />);
        await pressTestInstanceAsync(screen.findByTestId('session-start-failure-choose-model'));
        expect(chooseModel).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-start-failure-retry')).toBeNull();
        await screen.unmount();
        const readOnly = await renderScreen(<SessionStartFailureBanner notice={refused!} retry={null} />);
        expect(readOnly.findByTestId('session-start-failure-choose-model')).toBeNull();
        expect(readOnly.findByTestId('session-start-failure-retry')).toBeNull();
    });
    it('names the stored cause and retries through the supplied Resume owner', async () => {
        const run = vi.fn();
        const screen = await renderScreen(
            <SessionStartFailureBanner notice={notice} retry={{ run, busy: false }} />,
        );
        expect(screen.getTextContent()).toContain('Runner daemon authority is unavailable');
        await pressTestInstanceAsync(screen.findByTestId('session-start-failure-retry'));
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('offers no action that cannot run', async () => {
        const screen = await renderScreen(<SessionStartFailureBanner notice={notice} retry={null} />);
        expect(screen.getTextContent()).toContain('Runner daemon authority is unavailable');
        expect(screen.findByTestId('session-start-failure-retry')).toBeNull();
    });

    it('opens plugin recovery for a disabled Agent while its Machine is unavailable', async () => {
        const managePlugin = vi.fn();
        const screen = await renderScreen(<SessionStartFailureBanner
            notice={{ code: 'plugin_disabled', message: 'This Agent plugin is disabled.', retryable: false }}
            retry={null}
            managePlugin={managePlugin}
        />);
        await pressTestInstanceAsync(screen.findByTestId('session-start-failure-manage-plugin'));
        expect(managePlugin).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-start-failure-retry')).toBeNull();
    });

    it('does not render a Retry action for a permanent startup refusal even when Resume is available', async () => {
        const issue = SessionRuntimeIssueV1Schema.parse({ v: 1, scope: 'primary_session', status: 'failed', occurredAt: 1,
            code: 'codex_refresh_free_auth_unsupported', source: 'dependency_failure', agentId: 'codex',
            failureCause: { phase: 'authentication', failureReason: 'unclassified_provider_error', reason: 'refresh_bridge_unavailable' } });
        const refused = resolveSessionStartFailureNotice({ issue, sessionActive: false });
        expect(refused).not.toBeNull();
        const screen = await renderScreen(<SessionStartFailureBanner notice={refused!} retry={{ run: vi.fn(), busy: false }} />);
        expect(screen.findByTestId('session-start-failure-retry')).toBeNull();
    });
});
