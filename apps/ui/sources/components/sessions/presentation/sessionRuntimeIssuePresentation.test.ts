import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProviderBrokerAdmissionFailureCodeV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import {
    AGENT_STARTUP_FAILURE_PREVIEWS,
    SESSION_PREPARATION_FAILURE_PREVIEWS,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { resolveSessionStartFailureNotice } from '@/components/sessions/startFailure/sessionStartFailureNotice';
import { resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnNewAction';
import { SUPPORTED_LANGUAGE_CODES, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';

import { presentSessionRuntimeIssue } from './sessionRuntimeIssuePresentation';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { resourceStateLabel } from '@/components/settings/teams/credentials/readinessPresentation';

const KNOWN_CODE = 'native_agent_privileged_effect_authority_unavailable';
const ENGLISH_PREVIEW = SESSION_PREPARATION_FAILURE_PREVIEWS[KNOWN_CODE];
const CLOSED_CODES = [
    ...Object.keys(SESSION_PREPARATION_FAILURE_PREVIEWS),
    ...ProviderBrokerAdmissionFailureCodeV1Schema.options,
    ...Object.keys(AGENT_STARTUP_FAILURE_PREVIEWS),
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
                expect(message).toContain(code);
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
