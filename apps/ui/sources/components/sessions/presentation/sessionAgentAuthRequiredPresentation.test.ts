import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { SUPPORTED_LANGUAGE_CODES, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { presentProviderError } from '@/providers/connection/errorPresentation';

import { presentSessionAgentAuthRequired } from './sessionAgentAuthRequiredPresentation';
import { presentSessionRuntimeIssue } from './sessionRuntimeIssuePresentation';

/** The Provider-secret wording the host classifier writes for the closed Provider code. */
const PROVIDER_PREVIEW = 'The Provider endpoint requires a credential. Add a Saved Secret to the Provider connection.';

function issue(overrides: Partial<SessionRuntimeIssueV1>): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'provider_endpoint_auth_required',
        source: 'auth_error',
        occurredAt: 1_700_000_000_000,
        agentId: 'codex',
        sanitizedPreview: PROVIDER_PREVIEW,
        ...overrides,
    };
}

async function useLanguage(language: string): Promise<void> {
    await preloadTranslations(language as never);
    setPreferredLanguageFromSettings(language);
}

describe('native Agent authentication required', () => {
    beforeAll(async () => {
        await Promise.all(SUPPORTED_LANGUAGE_CODES.map(language => preloadTranslations(language)));
    });
    afterEach(() => setPreferredLanguageFromSettings('en'));

    it('names the Agent and asks for sign-in or an account, never a Provider secret', () => {
        const native = presentSessionAgentAuthRequired(issue({}));
        expect(native).toEqual({ agentId: 'codex', message: 'Sign in to Codex or choose a Codex account.' });
        expect(presentSessionRuntimeIssue(issue({})).message).toBe(native?.message);
    });

    it.each(['provider_account_identity_unavailable', 'workspace_incompatible', 'credential_family_mismatch', 'live_hot_auth_failed'] as const)(
        'uses the existing Agent sign-in recovery for startup authentication refusal %s', reason => {
            const refused = issue({ code: 'codex_refresh_free_auth_unsupported',
                failureCause: { phase: 'authentication', failureReason: 'authentication_required', reason } });
            expect(presentSessionAgentAuthRequired(refused)?.agentId).toBe('codex');
            expect(presentSessionRuntimeIssue(refused).message).toBe(t('session.agentAuthRequired.message', { agent: 'Codex' }));
        },
    );

    it('reads in every authored locale without falling back to the Provider diagnostic', async () => {
        for (const language of SUPPORTED_LANGUAGE_CODES.filter(code => code !== 'en')) {
            await useLanguage(language);
            const message = presentSessionAgentAuthRequired(issue({}))?.message;
            expect(message, language).toBeTruthy();
            expect(message, language).not.toBe('Sign in to Codex or choose a Codex account.');
            expect(message, language).toContain('Codex');
        }
    });

    it('localizes a Provider endpoint credential issue through its Provider owner in every locale', async () => {
        const provider = issue({ source: 'agent_session_error' });
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            await useLanguage(language);
            expect(presentSessionAgentAuthRequired(provider)).toBeNull();
            // The Provider owner's cause, then its instruction.
            const presented = presentProviderError('provider_endpoint_auth_required');
            expect(presentSessionRuntimeIssue(provider).message).toBe(`${t(presented.titleKey)}\n${t(presented.descriptionKey)}`);
        }
    });

    it('leaves connected-account authentication and Agent-less issues alone', () => {
        const connected = issue({ code: 'auth_error', sanitizedPreview: 'Connected account sign-in expired' });
        expect(presentSessionAgentAuthRequired(connected)).toBeNull();
        expect(presentSessionRuntimeIssue(connected).message).toBe('Connected account sign-in expired');
        expect(presentSessionAgentAuthRequired(issue({ agentId: undefined }))).toBeNull();
        expect(presentSessionAgentAuthRequired(null)).toBeNull();
    });
});
