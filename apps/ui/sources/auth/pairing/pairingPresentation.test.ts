import { describe, expect, it } from 'vitest';

import { formatPairingCountdown, resolveHomeEnrollmentPresentation } from './pairingPresentation';

type PresentationSource = Parameters<typeof resolveHomeEnrollmentPresentation>[0];

// Every non-terminal source each of the three QR surfaces can publish.
const DISPLAY_SOURCES: readonly PresentationSource[] = [
    ...(['generating', 'ready', 'adding', 'retryable_error', 'expired', 'invalid_request', 'update_required', 'succeeded'] as const)
        .map((phase) => ({ kind: 'trusted_home_display' as const, phase })),
    ...(['generating', 'ready', 'adding', 'expired', 'invalid', 'update_required', 'succeeded'] as const)
        .map((phase) => ({ kind: 'requester_display' as const, phase })),
    { kind: 'requester_display', phase: 'retryable_error', partialCommit: false },
    { kind: 'requester_display', phase: 'retryable_error', partialCommit: true },
];
const SCANNER_SOURCES: readonly PresentationSource[] = (['idle', 'requesting', 'securing'] as const)
    .map((phase) => ({ kind: 'scanner' as const, phase }));
const TERMINAL_FAILURE_PHASES = new Set(['expired', 'invalid_request', 'update_required', 'partial_commit']);

describe('resolveHomeEnrollmentPresentation', () => {
    it('keeps invalid and expired links distinct from an unavailable sign-in method', () => {
        const invalid = resolveHomeEnrollmentPresentation({ kind: 'scanner', phase: 'idle', result: 'invalid_request' });
        const expired = resolveHomeEnrollmentPresentation({ kind: 'scanner', phase: 'idle', result: 'expired' });
        expect(invalid).toMatchObject({ phase: 'invalid_request', primaryTranslationKey: 'terminal.invalidConnectionLinkDescription', activity: false });
        expect(expired).toMatchObject({ phase: 'expired', primaryTranslationKey: 'connect.pairingQrExpired', activity: false });
    });

    it('projects every surface phase onto the one semantic phase model', () => {
        const projected = [...DISPLAY_SOURCES, ...SCANNER_SOURCES].map((source) => [
            source, resolveHomeEnrollmentPresentation(source).phase,
        ] as const);
        for (const [source, phase] of projected) {
            const expected = source.kind === 'scanner'
                ? { idle: 'ready', requesting: 'verifying', securing: 'adding' }[source.phase]
                : source.kind === 'requester_display' && source.phase === 'invalid'
                    ? 'invalid_request'
                    : source.kind === 'requester_display' && source.partialCommit
                        ? 'partial_commit'
                        : source.phase;
            expect({ source, phase }).toEqual({ source, phase: expected });
        }
    });

    it('announces terminal failures assertively and marks only in-flight work as activity', () => {
        for (const source of [...DISPLAY_SOURCES, ...SCANNER_SOURCES]) {
            const presentation = resolveHomeEnrollmentPresentation(source);
            expect({ source, assertive: presentation.liveRegion === 'assertive' })
                .toEqual({ source, assertive: TERMINAL_FAILURE_PHASES.has(presentation.phase) });
            const inFlight = ['generating', 'verifying', 'adding'].includes(presentation.phase)
                || presentation.recoveryAction === 'automatic_retry';
            expect({ source, activity: presentation.activity }).toEqual({ source, activity: inFlight });
        }
    });

    it('offers a new QR only for an expired or invalid displayed code and no retry after a partial commit', () => {
        for (const source of DISPLAY_SOURCES) {
            const presentation = resolveHomeEnrollmentPresentation(source);
            expect({ source, createNewQr: presentation.recoveryAction === 'create_new_qr' }).toEqual({
                source,
                createNewQr: presentation.phase === 'expired' || presentation.phase === 'invalid_request',
            });
            if (presentation.phase === 'partial_commit') expect(presentation.recoveryAction).toBe('none');
        }
        expect(resolveHomeEnrollmentPresentation({ kind: 'requester_display', phase: 'retryable_error', partialCommit: false }))
            .toMatchObject({ phase: 'retryable_error', recoveryAction: 'retry' });
    });

    it('keeps a terminal success authoritative over a later transient scanner phase', () => {
        expect(resolveHomeEnrollmentPresentation({
            kind: 'scanner',
            phase: 'requesting',
            result: 'succeeded',
            direction: 'trusted_home_displays',
        })).toMatchObject({
            phase: 'succeeded',
            primaryTranslationKey: 'connect.homeAddedPreservedFocusBody',
            recoveryAction: 'none',
            activity: false,
        });
    });

    it('describes reverse-direction success from the approving Home\'s perspective', () => {
        expect(resolveHomeEnrollmentPresentation({
            kind: 'scanner',
            phase: 'requesting',
            result: 'succeeded',
            direction: 'requester_displays',
        })).toMatchObject({
            phase: 'succeeded',
            primaryTranslationKey: 'connect.requesterDeviceAddedBody',
            recoveryAction: 'none',
            activity: false,
        });
    });

    // Every terminal result the approver branch publishes speaks to the approver;
    // none may fall through to joiner/restore guidance.
    it.each([
        ['retryable_error', 'connect.requesterDeviceRetryBody', 'retry'],
        ['wrong_target', 'connect.requesterDeviceWrongHomeBody', 'retry'],
        ['expired', 'connect.requesterDeviceQrExpiredBody', 'retry'],
        ['invalid_request', 'connect.requesterDeviceRequestInvalidBody', 'retry'],
    ] as const)('describes reverse-direction %s from the approving Home\'s perspective', (result, primaryTranslationKey, recoveryAction) => {
        const joinerPresentation = resolveHomeEnrollmentPresentation({
            kind: 'scanner',
            phase: 'requesting',
            result,
            direction: 'trusted_home_displays',
        });
        const approverPresentation = resolveHomeEnrollmentPresentation({
            kind: 'scanner',
            phase: 'requesting',
            result,
            direction: 'requester_displays',
        });

        expect(approverPresentation).toEqual({ ...joinerPresentation, primaryTranslationKey, recoveryAction });
        expect(approverPresentation.primaryTranslationKey).not.toBe(joinerPresentation.primaryTranslationKey);
    });

    it('preserves partial commit as a terminal recovery state', () => {
        expect(resolveHomeEnrollmentPresentation({
            kind: 'scanner',
            phase: 'securing',
            result: 'partial_commit',
        })).toMatchObject({
            phase: 'partial_commit',
            primaryTranslationKey: 'connect.homeEnrollmentPartialCommitBody',
            contextualFacts: 'target',
            recoveryAction: 'none',
            liveRegion: 'assertive',
        });
    });
});

describe('formatPairingCountdown', () => {
    it('counts down to the invite expiry as m:ss, rounding up so it never reads 0:00 while the code still works', () => {
        const now = 1_000_000;
        expect(formatPairingCountdown(now + 272_000, now)).toBe('4:32');
        expect(formatPairingCountdown(now + 60_000, now)).toBe('1:00');
        expect(formatPairingCountdown(now + 9_001, now)).toBe('0:10');
        expect(formatPairingCountdown(now + 400, now)).toBe('0:01');
    });

    it('reads 0:00 once the invite has expired', () => {
        expect(formatPairingCountdown(5_000, 9_000)).toBe('0:00');
    });
});
