import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProviderBrokerAdmissionFailureCodeV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import {
    AGENT_STARTUP_FAILURE_PREVIEWS,
    REQUESTER_SESSION_RUNTIME_REFUSAL_PREVIEWS,
    SESSION_PREPARATION_FAILURE_PREVIEWS,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { resolveSessionStartFailureNotice } from '@/components/sessions/startFailure/sessionStartFailureNotice';
import { resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnNewAction';
import { SUPPORTED_LANGUAGE_CODES, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';

import { presentSessionActivationFailure, presentSessionRuntimeIssue, presentSessionStartupFailureCause } from './sessionRuntimeIssuePresentation';
import { SESSION_MODEL_TRANSITION_FAILURE_STATUSES, formatSessionModelTransitionFailureCode } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { getPendingMessageVisualState, pendingMessageStatesBlockedReason, resolveSessionDeliveryFailure } from '@/components/sessions/pending/pendingMessageVisualState';
import { resolvePendingActivationBanner } from '@/components/sessions/pending/resolvePendingActivationBanner';
import { shouldShowAbortButtonForSessionState } from '@/utils/sessions/sessionUtils';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { resourceStateLabel } from '@/components/settings/teams/credentials/readinessPresentation';

const KNOWN_CODE = 'native_agent_privileged_effect_authority_unavailable';
const ENGLISH_PREVIEW = SESSION_PREPARATION_FAILURE_PREVIEWS[KNOWN_CODE];
const CLOSED_CODES = [
    'SOURCE_RUNTIME_RELOAD_REQUIRED',
    ...Object.keys(SESSION_PREPARATION_FAILURE_PREVIEWS),
    ...ProviderBrokerAdmissionFailureCodeV1Schema.options,
    ...Object.keys(AGENT_STARTUP_FAILURE_PREVIEWS),
    ...Object.keys(REQUESTER_SESSION_RUNTIME_REFUSAL_PREVIEWS),
];

function issue(overrides: Partial<SessionRuntimeIssueV1>): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: KNOWN_CODE,
        source: 'dependency_failure',
        occurredAt: 1_700_000_000_000,
        sanitizedPreview: ENGLISH_PREVIEW,
        ...overrides,
    };
}

async function useLanguage(language: string): Promise<void> {
    await preloadTranslations(language as never);
    setPreferredLanguageFromSettings(language);
}

describe('closed startup-failure recovery copy', () => {
    it.each(Object.keys(AGENT_STARTUP_FAILURE_PREVIEWS).filter(code =>
        code.startsWith('plugin_exec_') || code.startsWith('native_adapter_'),
    ))('localizes %s without exposing its diagnostic code', async code => {
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            await useLanguage(language);
            const message = presentSessionStartupFailureCause(code);
            expect(message, `${language}:${code}`).toBeTruthy();
            expect(message).not.toContain('session.startFailure.cause.');
            expect(message).not.toContain(code);
        }
    });
    it.each(Object.keys(REQUESTER_SESSION_RUNTIME_REFUSAL_PREVIEWS))('explains %s through Resume and retained Session status', async code => {
        await useLanguage('en');
        const message = presentSessionStartupFailureCause(code);
        expect(message).toBeTruthy();
        expect(message).not.toContain(code);
        expect(resolveSessionSpawnNewResultFailureMessage({ type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code, message: 'PRIVATE_CUSTODY_BODY' } })).toContain(message);
        expect(presentSessionRuntimeIssue(issue({ code, sanitizedPreview: undefined })).message).toBe(message);
    });
    it('says each refused model change in plain words in every locale, never its code', async () => {
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            await useLanguage(language);
            const messages = SESSION_MODEL_TRANSITION_FAILURE_STATUSES.map((status) => {
                const code = formatSessionModelTransitionFailureCode(status);
                const message = presentSessionStartupFailureCause(code);
                expect(message, `${language}:${status}`).toBeTruthy();
                expect(message).not.toContain('session.startFailure.');
                expect(message).not.toContain(status);
                expect(presentSessionRuntimeIssue(issue({ code, sanitizedPreview: 'Native refusal: native_code; service=peer' })).message,
                    `${language}:${status}`).toBe(message);
                return message;
            });
            // One sentence per refusal: no two statuses read the same.
            expect(new Set(messages).size, language).toBe(messages.length);
        }
        expect(presentSessionStartupFailureCause('session_model_transition_owner_unproven')).toBeNull();
    });
    it('explains a server transaction timeout without startup phase facts in every locale', async () => {
        const code = 'database_transaction_timeout';
        for (const unrelatedCode of ['provider_response_invalid', 'runtime_refusal']) {
            expect(presentSessionStartupFailureCause(unrelatedCode)).toBeNull();
        }
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            await useLanguage(language);
            const message = t('session.startFailure.cause.database_transaction_timeout');
            expect(message, language).not.toContain('session.startFailure.');
            const failure = issue({ code, sanitizedPreview: undefined });
            expect(presentSessionRuntimeIssue(failure).message, language).toBe(message);
            expect(resolveSessionStartFailureNotice({ issue: failure, sessionActive: false })?.message, language).toBe(message);
            const outcome = resolveSessionSpawnNewResultFailureMessage({ type: 'error', code: 'spawn_failed', retryable: true,
                launchError: { kind: 'launch_error', code, message: 'PRIVATE_LAUNCH_BODY' } });
            expect(outcome, language).toContain(message);
            expect(outcome, language).not.toContain('PRIVATE_LAUNCH_BODY');
        }
    });
    it('asks for a model through both durable status and the launch Action, preserving ordinary reconciliation failures', async () => {
        await useLanguage('en');
        const code = 'agent_startup_model_reconciliation_failed';
        const failure = issue({ code, source: 'agent_session_error',
            failureCause: { code, phase: 'client_start', failureReason: 'model_selection_required', retryable: false } });
        // The cause says why it stopped; "Choose a model" stays the action's label, never repeated as the message.
        expect(t('session.startFailure.modelSelectionRequired')).not.toBe(t('newSession.selectModelTitle'));
        expect(presentSessionRuntimeIssue(failure).message).toBe(t('session.startFailure.modelSelectionRequired'));
        expect(resolveSessionStartFailureNotice({ issue: failure, sessionActive: false }))
            .toMatchObject({ message: t('session.startFailure.modelSelectionRequired'), retryable: false });
        const launch = { type: 'error' as const, code: 'spawn_failed' as const, retryable: false,
            launchError: { kind: 'launch_error' as const, code, message: 'Session launch failed', failureCause: failure.failureCause } };
        expect(resolveSessionSpawnNewResultFailureMessage(launch)).toContain(t('session.startFailure.modelSelectionRequired'));
        expect(presentSessionRuntimeIssue({ ...failure, failureCause: { phase: 'client_start', failureReason: 'unknown' } }).message)
            .toBe(t('session.startFailure.cause.agent_startup_model_reconciliation_failed'));
    });
    it('shows the retained safe attachment reason through the existing preparation presentation', async () => {
        await useLanguage('en');
        const failure = issue({ code: 'preparation_pending', sanitizedPreview: 'Prompt context could not be prepared.',
            failureCause: { phase: 'turn_start', failureReason: 'unknown',
                preparationCause: { code: 'triage_account_storage_unavailable', stage: 'dispatch' } } });
        const expected = t('errors.errorWithCode', { message: failure.sanitizedPreview!,
            code: 'triage_account_storage_unavailable' });
        expect(presentSessionRuntimeIssue(failure).message).toBe(expected);
        expect(resolveSessionStartFailureNotice({ issue: failure, sessionActive: false })?.message).toBe(expected);
    });
    it('shows the preparation request identity on the settled Session failure', async () => {
        await useLanguage('en');
        const failure = issue({ code: 'preparation_pending', sanitizedPreview: 'Prompt context could not be prepared.',
            failureCause: { phase: 'turn_start', failureReason: 'unknown', preparationCause: {
                code: 'plugin_action_handler_missing', stage: 'dispatch', requestId: 'preparation-request-132',
            } } });
        expect(presentSessionRuntimeIssue(failure).message).toContain('preparation-request-132');
        expect(resolveSessionStartFailureNotice({ issue: failure, sessionActive: false })?.message).toContain('preparation-request-132');
    });
    it('distinguishes missing machine support from an unsupported Agent API without prescribing account sign-in', async () => {
        await useLanguage('en');
        const missingBridge = issue({ code: 'codex_refresh_free_auth_unsupported', agentId: 'codex',
            failureCause: { phase: 'authentication', failureReason: 'unclassified_provider_error', reason: 'refresh_bridge_unavailable' } });
        const unsupportedApi = issue({ ...missingBridge,
            failureCause: { phase: 'authentication', failureReason: 'unclassified_provider_error', reason: 'experimental_api_unavailable' } });
        const bridgeMessage = presentSessionRuntimeIssue(missingBridge).message;
        const apiMessage = presentSessionRuntimeIssue(unsupportedApi).message;
        expect(bridgeMessage).toMatch(/reconnect.*update.*machine/i);
        expect(apiMessage).toMatch(/update.*agent/i);
        expect(apiMessage).not.toBe(bridgeMessage);
        expect(bridgeMessage).not.toMatch(/sign in/i);
        expect(apiMessage).not.toMatch(/sign in/i);
        expect(resolveSessionStartFailureNotice({ issue: missingBridge, sessionActive: false })?.message).toBe(bridgeMessage);
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            await useLanguage(language);
            const localizedBridge = presentSessionRuntimeIssue(missingBridge).message;
            const localizedApi = presentSessionRuntimeIssue(unsupportedApi).message;
            expect(localizedBridge, language).toBeTruthy();
            expect(localizedApi, language).toBeTruthy();
            expect(localizedBridge, language).not.toContain('session.startFailure.');
            expect(localizedApi, language).not.toContain('session.startFailure.');
            expect(localizedBridge, language).not.toBe(localizedApi);
            if (language !== 'en') {
                expect(localizedBridge, language).not.toBe(bridgeMessage);
                expect(localizedApi, language).not.toBe(apiMessage);
            }
        }
    });
    it('uses the existing broker update-required presentation for Action outcomes and retained issues in every locale', async () => {
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            await useLanguage(language);
            const code = 'update_required';
            const guidance = resourceStateLabel('update_required');
            const outcome = resolveSessionSpawnNewResultFailureMessage({
                type: 'error', code: 'spawn_failed', retryable: true,
                launchError: { kind: 'launch_error', code, message: 'private broker diagnostic' },
            });
            expect(outcome).toContain(guidance);
            expect(outcome).toContain(code);
            expect(outcome).not.toContain('private broker diagnostic');
            expect(presentSessionRuntimeIssue(issue({ code })).message).toBe(guidance);
        }
    });
    it('presents the isolation owner refusal with localized setup recovery', async () => {
        await useLanguage('de');
        expect(presentSessionRuntimeIssue(issue({ code: 'agent_isolation_unavailable', sanitizedPreview: undefined })).message)
            .toBe(t('errors.agentIsolationUnavailable'));
    });
    it('keeps source-owner reconnect recovery in the Action outcome as well as the retained issue', async () => {
        await useLanguage('en');
        const code = 'connected_service_credential_reconnect_required';
        const outcome = resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code, message: 'private source diagnostic' },
        });
        expect(outcome).toContain(t('teams.credentials.recovery.ownerHandoff'));
        expect(outcome).toContain(code);
        expect(outcome).not.toContain('private source diagnostic');
        expect(presentSessionRuntimeIssue(issue({ code })).message).toContain(t('teams.credentials.recovery.ownerHandoff'));
    });
    it.each(['provider_catalog_unavailable', 'provider_rpc_response_invalid', 'provider_model_not_found'])(
        'keeps the canonical %s reason and guidance in the Action outcome', async code => {
            await useLanguage('en');
            const message = resolveSessionSpawnNewResultFailureMessage({
                type: 'error', code: 'spawn_failed', retryable: true,
                launchError: { kind: 'launch_error', code, message: 'private upstream detail' },
            });
            expect(message).toContain(t(presentProviderError(code).descriptionKey));
            expect(message).toContain(code);
            expect(message).not.toContain('spawn_failed');
            expect(message).not.toContain('private upstream detail');
        },
    );
    it('uses the same choose-model guidance for the Action outcome and retained Team issue', async () => {
        await useLanguage('en');
        const code = 'team_credential_model_selection_required';
        const body = presentSessionRuntimeIssue(issue({ code, sanitizedPreview: undefined })).message;
        expect(body).toBeTruthy();
        const composer = resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code, message: 'private upstream detail' },
        });
        expect(composer).toContain(body!);
        expect(composer).toContain(code);
        expect(composer).not.toContain('private upstream detail');
        expect(composer).not.toContain('spawn_failed');
    });
    beforeAll(async () => {
        await Promise.all(SUPPORTED_LANGUAGE_CODES.map(language => preloadTranslations(language)));
    });
    afterEach(() => setPreferredLanguageFromSettings('en'));

    it('uses the credential owner’s broker recovery guidance in every locale at the composer and retained issue', async () => {
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            await useLanguage(language);
            const guidance = t('teams.credentials.errors.brokerUnavailable');
            const handoff = t('teams.credentials.recovery.ownerHandoff');
            const composer = resolveSessionSpawnNewResultFailureMessage({
                type: 'error', code: 'spawn_failed', retryable: true,
                launchError: { kind: 'launch_error', code: 'broker_unavailable', message: 'private broker diagnostic' },
            });
            expect(composer).toContain(guidance);
            expect(composer).toContain(handoff);
            expect(composer).toContain('broker_unavailable');
            expect(composer).not.toContain('spawn_failed');
            expect(composer).not.toContain('private broker diagnostic');
            expect(presentSessionRuntimeIssue(issue({ code: 'broker_unavailable' })).message).toContain(guidance);
        }
    });

    it.each(['daemon_draining', 'daemon_shutting_down'])('presents the %s launch refusal without private upstream prose', async code => {
        await useLanguage('en');
        const message = resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code, message: 'private upstream diagnostic' },
        });
        expect(message).toContain(code);
        expect(message).not.toContain('private upstream diagnostic');
        const body = presentSessionRuntimeIssue(issue({ code, sanitizedPreview: undefined })).message;
        expect(body).toBeTruthy();
        expect(message).toContain(body!);
    });

    it('presents a stored English cause in the active locale through the Session banner and the composer failure', async () => {
        await useLanguage('fr');
        const stored = issue({});

        const body = presentSessionRuntimeIssue(stored).message;
        expect(body).toBeTruthy();
        expect(body).not.toBe(ENGLISH_PREVIEW);
        expect(resolveSessionStartFailureNotice({ issue: stored, sessionActive: false })?.message).toBe(body);

        const composer = resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code: KNOWN_CODE, message: 'Runner exited before startup completed' },
        });
        expect(composer).toContain(body!);
        expect(composer).toContain(KNOWN_CODE);
        expect(composer).not.toContain(ENGLISH_PREVIEW);
    });

    it('localizes a known cause even when the stored issue kept no preview', async () => {
        await useLanguage('de');
        const { sanitizedPreview: _stored, ...withoutPreview } = issue({});
        const body = presentSessionRuntimeIssue(withoutPreview as SessionRuntimeIssueV1).message;
        expect(body).toBeTruthy();
        expect(body).not.toBe(ENGLISH_PREVIEW);
    });

    it('preserves every closed code and localized cause at the composer and retained issue in every locale', async () => {
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            await useLanguage(language);
            for (const code of CLOSED_CODES) {
                const body = presentSessionRuntimeIssue(issue({ code, sanitizedPreview: undefined })).message;
                expect(body, `${language}:${code}`).toBeTruthy();
                expect(body).not.toContain('session.startFailure.cause.');
                expect(presentSessionRuntimeIssue(issue({ code })).message).toBe(body);
                if (language !== 'en') {
                    expect(body, `${language}:${code}`).not.toBe(
                        (SESSION_PREPARATION_FAILURE_PREVIEWS as Record<string, string>)[code]
                        ?? (AGENT_STARTUP_FAILURE_PREVIEWS as Record<string, string>)[code],
                    );
                }
                const message = resolveSessionSpawnNewResultFailureMessage({
                    type: 'error', code: 'spawn_failed', retryable: true,
                    launchError: { kind: 'launch_error', code, message: 'private native response' },
                });
                if (code === 'SOURCE_RUNTIME_RELOAD_REQUIRED') {
                    expect(message).not.toContain(code);
                    expect(message).toContain(t('workflows.recovery.reloadSourceRuntime'));
                    expect(body).toContain(t('workflows.recovery.reloadSourceRuntime'));
                    expect(presentSessionRuntimeIssue(issue({ code })).details).toContain(code);
                    expect(resolveSessionStartFailureNotice({ issue: issue({ code }), sessionActive: false })?.message).toContain(
                        t('workflows.recovery.reloadSourceRuntime'),
                    );
                } else expect(message).toContain(code);
                expect(message).toContain(body!);
                expect(message).not.toContain('private native response');
                expect(message).not.toContain('spawn_failed');
            }
        }
    });

    it('keeps the stored cause for an unknown code and never names private text in the composer', async () => {
        await useLanguage('fr');
        expect(presentSessionRuntimeIssue(issue({ code: 'agent_session_error', sanitizedPreview: 'Agent session failed' })).message)
            .toBe('Agent session failed');
        expect(presentSessionRuntimeIssue(issue({ code: 'agent_session_error', sanitizedPreview: undefined })).message).toBeNull();
        const unknown = resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code: 'daemon_private_cause', message: 'private detail' },
        });
        expect(unknown).toContain('spawn_failed');
        expect(unknown).not.toContain('daemon_private_cause');
        expect(unknown).not.toContain('private detail');
    });
});

describe('a usage-limit failure, said once', () => {
    it('summarizes as the limit itself, keeping provider advice for Details', async () => {
        await useLanguage('en');
        const quota = issue({ code: 'usage_limit', source: 'usage_limit',
            sanitizedPreview: 'Codex usage limit reached. Try another connected account or try again after your limit resets.',
            usageLimit: { v: 1, resetAtMs: null, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } });
        const presented = presentSessionRuntimeIssue(quota);
        expect(presented.summary).toBe(t('session.usageLimitRecovery.banner.title'));
        expect(presented.details).toContain('Try another connected account');
    });

    it('says a reset later today as a time, the way the usage page does, never with its year', async () => {
        await useLanguage('en');
        const resetAtMs = Date.now() + 2 * 60 * 60 * 1000;
        const presented = presentSessionRuntimeIssue(issue({ code: 'usage_limit', source: 'usage_limit',
            usageLimit: { v: 1, resetAtMs, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } }));
        expect(presented.reset).not.toBeNull();
        expect(presented.reset).not.toContain(String(new Date(resetAtMs).getFullYear()));
    });
});

describe('a Session whose Agent account refused queued input: one message and one next action', () => {
    const failed = { requestId: 'first-input', requestedAt: 200, status: 'failed' as const, failureCode: 'runtime_start_failed' as const };
    const reconnect = { reason: 'spawn-rejected' as const, spawnErrorCode: 'SPAWN_VALIDATION_FAILED' as const,
        runtimeReason: 'connected_service_credential_reconnect_required' as const };
    const blockedFirstInput = { id: 'row-1', localId: 'first-input', createdAt: 10, updatedAt: 10, text: 'hello', rawRecord: {},
        messageRole: 'user' as const, source: 'server_pending' as const,
        pendingDeliveryStatus: 'blocked' as const, pendingDeliveryBlockedReason: 'runtime_config_blocked' as const };

    it('keeps a non-retryable native continuation refusal distinct from a failed wake or temporary provider outage', async () => {
        await useLanguage('en');
        const session = { activeAt: 300, active: false, pendingActivationAuthorization: null,
            lastRuntimeIssue: issue({ code: 'codex_continuation_unreachable', source: 'agent_session_error',
                failureCause: { phase: 'thread_open', failureReason: 'unclassified_provider_error', retryable: false } }) };
        const blocked = { ...blockedFirstInput, pendingDeliveryBlockedReason: 'provider_rejected_before_acceptance' as const };
        expect(resolveSessionDeliveryFailure([blocked], session, false)).toEqual({
            message: t('workflows.problem.conversationUnavailable'), recovery: 'new_session' });
        const visual = getPendingMessageVisualState(blocked, { session });
        expect(pendingMessageStatesBlockedReason(visual)).toBe(false);
        expect(resolveSessionDeliveryFailure([blocked], { ...session, active: true }, false)).toBeNull();
        expect(resolveSessionDeliveryFailure([blocked], { ...session, lastRuntimeIssue: issue({ code: 'provider_unavailable' }) }, false)).toBeNull();
        expect(resolveSessionDeliveryFailure([{ ...blocked, pendingDeliveryStatus: 'server_queued' }], session, false)).toBeNull();
    });

    it('offers account recovery only for credential or pool refusals', async () => {
        await useLanguage('en');
        expect(presentSessionActivationFailure(reconnect)).toEqual({
            message: t('connectedServices.diagnostics.title.connected_service_credential_reconnect_required'),
            detail: t('connectedServices.diagnostics.body.connected_service_credential_reconnect_required'),
            recovery: 'sign_in_again',
        });
        expect(presentSessionActivationFailure({ ...reconnect, runtimeReason: 'no_eligible_member' })).toMatchObject({
            message: t('connectedServices.diagnostics.title.no_eligible_group_member'), recovery: 'choose_account' });
        expect(presentSessionActivationFailure(null)).toEqual({
            message: t('session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked'), recovery: null });
        expect(presentSessionActivationFailure({ reason: 'spawn-rejected', runtimeReason: 'transport_unavailable' }))
            .toMatchObject({ recovery: null });
    });

    it('is said once: the Session-level answer carries the typed cause and the blocked row paints no notice', async () => {
        await useLanguage('en');
        const session = { activeAt: 100, pendingActivationAuthorization: failed, pendingActivationFailureDetails: reconnect };
        expect(resolveSessionDeliveryFailure([blockedFirstInput], session, false)).toEqual(presentSessionActivationFailure(reconnect));
        const row = getPendingMessageVisualState(blockedFirstInput, { session });
        expect(row.deliveryBlockedPresentation?.message).toBeUndefined();
        expect(pendingMessageStatesBlockedReason(row)).toBe(false);
        expect(resolvePendingActivationBanner({ authorization: failed, activeAt: 100, active: false, machineReachable: true,
            canWrite: true, pendingMessages: [blockedFirstInput] })).not.toHaveProperty('titleKey');
    });

    it('never blames an untyped delivery refusal on the Session\'s earlier failure', async () => {
        await useLanguage('en');
        const session = { activeAt: 100, active: false, pendingActivationAuthorization: null, pendingActivationFailureDetails: null,
            lastRuntimeIssue: issue({ code: 'claude_rate_limit', source: 'agent_session_error',
                sanitizedPreview: "You've hit your weekly limit · resets Nov 9, 4pm (Europe/Amsterdam)" }) };
        const blocked = { id: 'row-2', localId: 'other-input', createdAt: 10, updatedAt: 10, text: 'hi', rawRecord: {},
            messageRole: 'user' as const, source: 'server_pending' as const,
            pendingDeliveryStatus: 'blocked' as const, pendingDeliveryBlockedReason: 'runtime_config_blocked' as const };
        // The refusal is decided by the wake's own spawn result, which can refuse for many causes.
        expect(resolveSessionDeliveryFailure([blocked], session, false)?.message)
            .toBe(t('session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked'));
    });

    it('offers no Stop while nothing runs and the person must recover blocked input', () => {
        expect(shouldShowAbortButtonForSessionState('action_required', 'blocked_input')).toBe(false);
        expect(shouldShowAbortButtonForSessionState('action_required', 'request')).toBe(true);
        expect(shouldShowAbortButtonForSessionState('thinking')).toBe(true);
    });
});
