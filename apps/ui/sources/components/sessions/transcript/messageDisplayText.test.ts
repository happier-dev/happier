import { describe, expect, it } from 'vitest';
import { buildTrustedHostSessionInputAdmissionV1, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { AgentTextMessage, UserTextMessage } from '@happier-dev/session-core/messages';
import { resolveTranscriptMessageDisplayText } from './messageDisplayText';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { presentSessionTeamCredentialDenial } from '../presentation/sessionTeamCredentialDenialPresentation';
import { readRuntimeIssueMessageMeta } from './events/runtimeIssueMessage';
import { presentSessionRuntimeIssue } from '../presentation/sessionRuntimeIssuePresentation';
import { resolveSessionStartFailureNotice } from '../startFailure/sessionStartFailureNotice';
import { buildSessionHostOnboardingInputV1 } from '@happier-dev/protocol/sessions/creation/sessionPreparedBirthV1';

const agent = (overrides: Partial<AgentTextMessage> = {}): AgentTextMessage => ({
    kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: 'visible', ...overrides,
});
const user = (overrides: Partial<UserTextMessage> = {}): UserTextMessage => ({
    kind: 'user-text', id: 'u', localId: null, createdAt: 1, text: 'visible', ...overrides,
});

describe('resolveTranscriptMessageDisplayText', () => {
    it('retains private native startup detail in rendering, Find and copy', () => {
        const nativeMessage = 'stage=exec errno=EACCES: cannot open /private/member/project/CODEX_HOME';
        const normalized = normalizeRawMessage('private-startup', 'private-startup', 100, {
            role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
                type: 'message', message: `Codex turn failed: ${nativeMessage}`,
            } }, meta: { source: 'runtime', runtimeIssueV1: {
                v: 1, scope: 'primary_session', status: 'failed', code: 'agent_startup_rpc_rejected',
                source: 'agent_session_error', occurredAt: 100, agentId: 'codex', sanitizedPreview: nativeMessage,
                failureCause: { code: 'agent_startup_rpc_rejected', phase: 'client_start',
                    failureReason: 'unclassified_provider_error', providerErrorCode: -32603,
                    providerErrorMessage: nativeMessage },
            } },
        });
        const message = agent({ meta: normalized?.meta, text: `Codex turn failed: ${nativeMessage}` });
        for (const preserveInlineReferences of [false, true]) {
            expect(resolveTranscriptMessageDisplayText(message, { preserveInlineReferences }).text).toContain(nativeMessage);
        }
    });

    it('words a startup preparation failure row with the start-failure presenter, not the raw provider line', () => {
        const preview = 'Agent isolation is unavailable. Ask the machine owner to review its setup, then retry the session.';
        const issue = { v: 1 as const, scope: 'primary_session' as const, status: 'failed' as const, code: 'agent_isolation_unavailable',
            source: 'dependency_failure' as const, occurredAt: 100, agentId: 'codex', sanitizedPreview: preview };
        const normalized = normalizeRawMessage('isolation', 'isolation', 100, {
            role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: `codex turn failed: ${preview}` } },
            meta: { source: 'runtime', runtimeIssueV1: issue },
        });
        const text = resolveTranscriptMessageDisplayText(agent({ meta: normalized?.meta, text: `codex turn failed: ${preview}` })).text;
        expect(text).toBe(resolveSessionStartFailureNotice({ issue, sessionActive: false })?.message);
        expect(text).not.toContain('turn failed');
    });

    it('keeps host onboarding model instructions out of Find and copy while preserving the same person-authored words', () => {
        const onboarding = buildSessionHostOnboardingInputV1({ templateName: 'Garden', templateVersion: '1.2.3', authorDisplayName: 'Ana' });
        const text = onboarding.initialInput.text;
        const host = user({ text, meta: { ...onboarding.meta, happierProvenanceV1: onboarding.inputAdmission.provenance } });
        for (const preserveInlineReferences of [false, true]) {
            const display = resolveTranscriptMessageDisplayText(host, { preserveInlineReferences });
            expect(display.text).toContain('Ana');
            expect(display.text).toContain('v1.2.3');
            expect(display.text).not.toContain(text);
            expect(resolveTranscriptMessageDisplayText(user({ text, meta: onboarding.meta }), { preserveInlineReferences }).text).toBe(text);
        }
    });
    it('marks direct-session Voice input from its canonical admission provenance while keeping ordinary text unmarked', () => {
        const text = 'HULLO PLEASE keep API and iOS';
        for (const surface of ['voice', 'ui'] as const) {
            const admission = buildTrustedHostSessionInputAdmissionV1(surface);
            expect(resolveTranscriptMessageDisplayText(user({ text,
                meta: { [SESSION_MESSAGE_PROVENANCE_META_KEY]: admission.provenance },
            }))).toMatchObject({ text, isVoiceAgentTurn: surface === 'voice' });
        }
    });

    it('retains the Provider model repair guidance in rendering, Find and copy', () => {
        // Redacted stored-issue vector from PERF #40, native turn 01a180c1-505e-7dd1-a8ed-82b1d87c9001.
        // Evidence: .project/tmp/providers-audit/diag-c275/status-fields.log; raw text is the host's generic failure preview.
        const normalized = normalizeRawMessage('model-failure', 'model-failure', 1793161527008, {
            role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
                type: 'message', message: 'codex turn failed: Codex app-server turn failed.',
            } }, meta: { source: 'runtime', runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed',
                code: 'provider_model_not_found', source: 'agent_session_error', occurredAt: 1793161527008,
                agentId: 'codex', agentTurnId: '01a180c1-505e-7dd1-a8ed-82b1d87c9001',
                failureCause: { code: 'provider_model_not_found', phase: 'turn',
                    failureReason: 'unclassified_provider_error', providerErrorCode: 'model_not_found' } } },
        });
        const message = agent({ meta: normalized?.meta, text: 'codex turn failed: Codex app-server turn failed.' });
        const guidance = presentSessionRuntimeIssue(readRuntimeIssueMessageMeta(message.meta)).message;
        expect(guidance).toBeTruthy();
        expect(resolveTranscriptMessageDisplayText(message).text).toBe(guidance);
        expect(resolveTranscriptMessageDisplayText(agent({ text: message.text })).text).toBe(message.text);
        expect(resolveTranscriptMessageDisplayText(agent({ ...message, isThinking: true })).text).toBe(message.text);
    });

    it('words a usage-limit failure row like the card\'s cause, with its reset and no native prefix', () => {
        const normalized = normalizeRawMessage('quota-failure', 'quota-failure', 1794000000000, {
            role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
                type: 'message', message: 'codex turn failed: Usage limit reached',
            } }, meta: { source: 'runtime', runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed',
                code: 'usage_limit', source: 'usage_limit', occurredAt: 1794000000000, agentId: 'codex',
                sanitizedPreview: 'Codex usage limit reached. Try another connected account or try again after your limit resets.',
                usageLimit: { v: 1, resetAtMs: 1794056400000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } } },
        });
        const message = agent({ meta: normalized?.meta, text: 'codex turn failed: Usage limit reached' });
        const issue = presentSessionRuntimeIssue(readRuntimeIssueMessageMeta(message.meta));
        const text = resolveTranscriptMessageDisplayText(message).text;
        expect(text).toBe(`${issue.summary} · ${issue.reset}`);
        expect(text).not.toContain('codex turn failed');
        expect(text).not.toContain('Try another connected account');
    });

    it('gives rendering, Find and copy the same named Team refusal instead of the native fallback', () => {
        const normalized = normalizeRawMessage('failure', 'failure', 1000, {
            role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
                type: 'message', message: 'Shared Team credential refused the request',
            } }, meta: { source: 'runtime', runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed',
                code: 'team_credential', source: 'team_credential', occurredAt: 1000,
                teamCredential: { v: 1, resourceId: 'selected-resource', reasonCode: 'resource_forbidden' } } },
        });
        const message = agent({ meta: normalized?.meta, text: 'Shared Team credential refused the request' });
        const presentation = presentSessionTeamCredentialDenial({ issue: readRuntimeIssueMessageMeta(message.meta),
            resolveResourceDisplayName: () => null });
        expect(presentation).not.toBeNull();
        expect(resolveTranscriptMessageDisplayText(message).text).toBe([presentation?.title, presentation?.body].filter(Boolean).join(' · '));
    });

    it('shows a native Agent sign-in requirement as its guidance, and keeps a Provider credential issue\'s own text', () => {
        const issueMeta = (source: 'auth_error' | 'agent_session_error') => ({ source: 'runtime', runtimeIssueV1: {
            v: 1, scope: 'primary_session', status: 'failed', code: 'provider_endpoint_auth_required', source,
            occurredAt: 1000, agentId: 'codex' } }) as AgentTextMessage['meta'];
        const providerText = 'codex turn failed: The Provider endpoint requires a credential. Add a Saved Secret to the Provider connection.';
        expect(resolveTranscriptMessageDisplayText(agent({ meta: issueMeta('auth_error'), text: providerText })).text)
            .toBe('Sign in to Codex or choose a Codex account.');
        expect(resolveTranscriptMessageDisplayText(agent({ meta: issueMeta('agent_session_error'), text: providerText })).text)
            .toBe(providerText);
    });

    it('shows readable markers to human readers, but retains tokens for the Markdown chip renderer', () => {
        const token = '[Auth](happier-ref:session:s1)';
        const message = user({
            text: `Compare ${token} and [unbound](happier-ref:session:s2)`,
            meta: { happierStructuredInputV1: { v: 1, mentions: [{ kind: 'happier.session', ref: 'session:s1', token, label: 'Auth' }] } },
        });
        expect(resolveTranscriptMessageDisplayText(message).text).toBe('Compare @Session "Auth" and unbound');
        expect(resolveTranscriptMessageDisplayText(message, { preserveInlineReferences: true }).text).toBe(message.text);
        expect(resolveTranscriptMessageDisplayText(agent({ text: message.text })).text).toBe('Compare Auth and unbound');
    });

    it('prepares the exact source input for Markdown rendering rather than hidden message scaffolding', () => {
        expect(resolveTranscriptMessageDisplayText(user({ displayText: '**display override**' })).text).toBe('**display override**');
        expect(resolveTranscriptMessageDisplayText(user({
            text: '**visible**\n\nAttachments:\n[attachments]\nprivate suffix\n[/attachments]',
            meta: { happier: { kind: 'attachments.v1', payload: { attachments: [{ name: 'note', path: '/note', sizeBytes: 1 }] } } },
        })).text).toBe('**visible**');
        expect(resolveTranscriptMessageDisplayText(agent({ isThinking: true, text: '*Thinking...*\n\n*visible 😀*' })).text).toBe('visible 😀');
        expect(resolveTranscriptMessageDisplayText(user({
            text: 'Context updates since your last voice turn:\nprivate context\n\nUser said:\n**visible**',
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 } } },
        }))).toMatchObject({ text: '**visible**', isVoiceAgentTurn: true });
    });

    it('uses canonical visibility and developer diagnostics for thinking and unsupported content', () => {
        expect(resolveTranscriptMessageDisplayText(agent({ isThinking: true }), { thinkingDisplayMode: 'hidden' }).text).toBeNull();
        const unsupported = agent({ text: '  diagnostic payload  ', meta: { happierUnsupportedContentV1: 'unsupported-agent-output' } });
        expect(resolveTranscriptMessageDisplayText(unsupported).text).toBeNull();
        expect(resolveTranscriptMessageDisplayText(unsupported, { debugInformationEnabled: true })).toMatchObject({
            text: 'diagnostic payload', unsupportedContentText: 'diagnostic payload',
        });
    });
});
