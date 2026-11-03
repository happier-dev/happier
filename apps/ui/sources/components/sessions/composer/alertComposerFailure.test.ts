import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestartSessionRunnerResultV1 } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { Modal } from '@/modal';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import {
    alertComposerActionResultFailure,
    alertComposerError,
    alertComposerRunnerRestartFailure,
    alertComposerRuntimeStatusUnavailable,
} from './alertComposerFailure';

beforeEach(() => vi.clearAllMocks());

function readDisclosure(text: string): Record<string, unknown> {
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        return { code: text };
    }
}

/** The alert the person sees, and the Technical details it opens when they press it. */
function openedAlert() {
    const [title, message, buttons] = vi.mocked(Modal.alert).mock.calls.at(0) ?? [];
    const technical = buttons?.find((button) => button.text === t('approvals.technicalDetails'));
    vi.mocked(Modal.alert).mockClear();
    technical?.onPress?.();
    const disclosed = vi.mocked(Modal.alert).mock.calls.at(0);
    return {
        title,
        message,
        offersTechnicalDetails: technical !== undefined,
        disclosedTitle: disclosed?.[0],
        // A failure with no further context discloses its bare code.
        disclosed: typeof disclosed?.[1] === 'string' ? readDisclosure(disclosed[1]) : null,
    };
}

describe('the composer failure presenter', () => {
    it.each([
        ['runner_not_active', 'runnerUnavailableBody'],
        ['unsupported_daemon', 'updateDaemonBody'],
        ['partial_failure', 'statusFailedBody'],
    ] as const)('offers recovery for %s and preserves the transport code', (status, key) => {
        alertComposerRunnerRestartFailure({ ok: false, status, sessionId: 'session-1',
            diagnostics: status === 'partial_failure' ? { errorCode: 'RPC_TRANSPORT_UNAVAILABLE' } : undefined });
        const alert = openedAlert();
        expect(alert.message).toBe(t(`session.staleRunner.banner.${key}`));
        if (status === 'partial_failure') expect(alert.disclosed).toMatchObject({ code: 'RPC_TRANSPORT_UNAVAILABLE' });
    });
    it('keeps the Action code and its safe details behind Technical details when Send throws', () => {
        alertComposerError(new HappyError('invalid_parameters', false, {
            code: 'invalid_parameters',
            details: {
                reasonCode: 'missing_machine_target',
                retryable: false,
                // Anything that is not a closed reason code never reaches the screen.
                token: 'abcdef0123456789',
                fields: [{ path: 'input.secret', message: 'free prose from the producer' }],
                error: 'free prose from the producer',
            },
        }));
        const alert = openedAlert();
        expect(alert.title).toBe(t('common.error'));
        expect(alert.message).toBe(t('common.requestFailed'));
        expect(alert.offersTechnicalDetails).toBe(true);
        expect(alert.disclosedTitle).toBe(t('approvals.technicalDetails'));
        expect(alert.disclosed).toEqual({ code: 'invalid_parameters', reasonCode: 'missing_machine_target', retryable: false });
    });

    it('keeps the readable message of an untyped Send failure and offers no empty details', () => {
        alertComposerError(new Error('Session is archived'));
        const alert = openedAlert();
        expect(alert.message).toBe('Session is archived');
        expect(alert.offersTechnicalDetails).toBe(false);
    });

    it('says why a refused runner restart failed and discloses its status, reason code and safe diagnostics', () => {
        const result: RestartSessionRunnerResultV1 = {
            ok: false,
            status: 'busy',
            sessionId: 'session-1',
            reasonCode: 'turn_in_progress',
            diagnostics: { busySource: 'native_background_work', errorCode: 'socket closed while reading /home/me/key' },
        };
        alertComposerRunnerRestartFailure(result);
        const alert = openedAlert();
        expect(alert.message).toBe(t('session.staleRunner.banner.busyBody'));
        expect(alert.offersTechnicalDetails).toBe(true);
        expect(alert.disclosed).toEqual({
            code: 'turn_in_progress', status: 'busy', reasonCode: 'turn_in_progress', busySource: 'native_background_work',
        });
    });

    it('tells a runner that cannot restart safely to stop and resume, with the status as its code', () => {
        alertComposerRunnerRestartFailure({ ok: false, status: 'restart_admission_unsupported', sessionId: 'session-1' });
        const alert = openedAlert();
        expect(alert.message).toBe(t('session.staleRunner.banner.stopAndResumeBody'));
        expect(alert.disclosed).toEqual({ code: 'restart_admission_unsupported', status: 'restart_admission_unsupported' });
    });

    it('names an unreadable runner status instead of a bare request failure', () => {
        alertComposerRuntimeStatusUnavailable();
        const alert = openedAlert();
        expect(alert.message).toBe(t('session.staleRunner.banner.unavailableBody'));
        expect(alert.disclosed).toEqual({ code: 'runner_status_unavailable' });
    });

    it('keeps the code and safe details of a refused Action result', () => {
        alertComposerActionResultFailure({
            ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
            details: { reasonCode: 'session_not_found', fields: [{ path: 'x' }] },
        });
        const alert = openedAlert();
        expect(alert.message).toBe(t('common.requestFailed'));
        expect(alert.disclosed).toEqual({ code: 'invalid_parameters', reasonCode: 'session_not_found' });
    });
});
