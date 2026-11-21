import { describe, expect, it } from 'vitest';
import { buildTrustedHostSessionInputAdmissionV1, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { AgentTextMessage, UserTextMessage } from '@happier-dev/session-core/messages';
import { resolveTranscriptMessageDisplayText } from './messageDisplayText';
import { resolveActionTitle } from '@/text/actionTitles';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { presentSessionTeamCredentialDenial } from '../presentation/sessionTeamCredentialDenialPresentation';
import { readRuntimeIssueMessageMeta } from './events/runtimeIssueMessage';
import { formatSessionFailureLine, presentSessionRuntimeIssue } from '../presentation/sessionRuntimeIssuePresentation';
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
        expect(text).toBe(formatSessionFailureLine([resolveSessionStartFailureNotice({ issue, sessionActive: false })?.message]));
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
    it('shows a decided approval result as a readable receipt, never its payload', () => {
        // actionExecutor delivers the result the Agent reads as host input with the approval's local id.
        const payload = JSON.stringify({ artifactId: 'approval-1', actionId: 'browser.view.open', ok: true, status: 'executed',
            execution: { ok: true, result: { browserSessionId: 'browser-1', profileId: 'profile-1' } } });
        const meta = { [SESSION_MESSAGE_PROVENANCE_META_KEY]: buildTrustedHostSessionInputAdmissionV1('mcp').provenance };
        const receipt = user({ text: payload, localId: 'approval-result:approval-1', meta });
        for (const preserveInlineReferences of [false, true]) {
            const text = resolveTranscriptMessageDisplayText(receipt, { preserveInlineReferences }).text ?? '';
            expect(text).toContain(resolveActionTitle('browser.view.open', null));
            expect(text).not.toContain('artifactId');
            expect(text).not.toContain('{');
        }
        // A person's own message with the same words keeps them.
        expect(resolveTranscriptMessageDisplayText(user({ text: payload, meta })).text).toBe(payload);
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
        expect(resolveTranscriptMessageDisplayText(message).text).toBe(formatSessionFailureLine([guidance]));
        expect(resolveTranscriptMessageDisplayText(agent({ text: message.text })).text).toBe(message.text);
        expect(resolveTranscriptMessageDisplayText(agent({ ...message, isThinking: true })).text).toBe(message.text);
    });

    it('words a refused model change by its transition status; the Agent\'s raw refusal waits in Details', () => {
        // Stored-issue vector from QA-MATRIX CONT4 CP1 (UNSEEN-COORD-B2-SESSION-1117 row 4): a custom ACP Agent refused
        // the model switch; the host recorded the transition status as the code and the Agent's words as the preview.
        const raw = 'Native model transition requires restart: native_model_restart_required; service=qa-cp1-peer';
        const normalized = normalizeRawMessage('model-transition', 'model-transition', 1794846630930, {
            role: 'agent', content: { type: 'acp', agentId: 'custom-acp', data: {
                type: 'message', message: `Custom ACP Agent turn failed: ${raw}`,
            } }, meta: { source: 'runtime', runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed',
                code: 'session_model_transition_apply_failed', source: 'agent_session_error', occurredAt: 1794846630930,
                agentId: 'custom-acp', sanitizedPreview: raw,
                failureCause: { phase: 'turn', failureReason: 'unclassified_provider_error',
                    providerErrorCode: -32000, providerErrorMessage: raw } } },
        });
        const message = agent({ meta: normalized?.meta, text: `Custom ACP Agent turn failed: ${raw}` });
        const issue = presentSessionRuntimeIssue(readRuntimeIssueMessageMeta(message.meta));
        const text = resolveTranscriptMessageDisplayText(message).text;
        expect(text).toBe(issue.message);
        expect(text).not.toContain('native_model_restart_required');
        expect(issue.details).toContain(raw);
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
        expect(text).toBe(formatSessionFailureLine([issue.summary, issue.reset]));
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
        expect(resolveTranscriptMessageDisplayText(message).text).toBe(formatSessionFailureLine([presentation?.title, presentation?.body]));
    });

    it('shows a native Agent sign-in requirement as its guidance, and keeps a Provider credential issue\'s own text', () => {
        const issueMeta = (source: 'auth_error' | 'agent_session_error') => ({ source: 'runtime', runtimeIssueV1: {
            v: 1, scope: 'primary_session', status: 'failed', code: 'provider_endpoint_auth_required', source,
            occurredAt: 1000, agentId: 'codex' } }) as AgentTextMessage['meta'];
        const providerText = 'codex turn failed: The Provider endpoint requires a credential. Add a Saved Secret to the Provider connection.';
        expect(resolveTranscriptMessageDisplayText(agent({ meta: issueMeta('auth_error'), text: providerText })).text)
            .toMatch(/^Codex .+ · Sign in to Codex or choose a Codex account\.$/u);
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

describe('failure line anatomy', () => {
    // Every runtime failure row the transcript draws (the /dev/session-states rows plus a native startup refusal
    // carrying its provider text): one line, "what failed · its cause or next step", ending as a sentence.
    const failureRow = (issue: Record<string, unknown>, text = 'codex turn failed: native text') => {
        const normalized = normalizeRawMessage('failure-line', 'failure-line', 1794000000000, {
            role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: text } },
            meta: { source: 'runtime', runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed',
                occurredAt: 1794000000000, agentId: 'codex', ...issue } },
        });
        return resolveTranscriptMessageDisplayText(agent({ meta: normalized?.meta, text })).text;
    };
    const rows = {
        modelNotFound: failureRow({ code: 'provider_model_not_found', source: 'agent_session_error',
            failureCause: { code: 'provider_model_not_found', phase: 'turn', failureReason: 'unclassified_provider_error',
                providerErrorCode: 'model_not_found' } }),
        modelTransition: failureRow({ code: 'session_model_transition_apply_failed', source: 'agent_session_error',
            sanitizedPreview: 'native_model_restart_required' }),
        teamRefusal: failureRow({ code: 'team_credential', source: 'team_credential',
            teamCredential: { v: 1, resourceId: 'r', reasonCode: 'resource_forbidden' } }),
        teamReconnect: failureRow({ code: 'team_credential', source: 'team_credential',
            teamCredential: { v: 1, resourceId: 'r', reasonCode: 'connected_service_credential_reconnect_required' } }),
        usageLimit: failureRow({ code: 'usage_limit', source: 'usage_limit',
            usageLimit: { v: 1, resetAtMs: 1794056400000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } }),
        agentSignIn: failureRow({ code: 'provider_endpoint_auth_required', source: 'auth_error' }),
        startupRefusal: failureRow({ code: 'agent_startup_rpc_rejected', source: 'agent_session_error',
            failureCause: { code: 'agent_startup_rpc_rejected', phase: 'client_start', failureReason: 'unclassified_provider_error',
                providerErrorCode: -32603, providerErrorMessage: 'stage=exec errno=EACCES' } }),
        unexplained: failureRow({ code: 'agent_session_error', source: 'agent_session_error', sanitizedPreview: 'exit 1' }),
    };

    it.each(Object.entries(rows))('%s reads as one line ending as a sentence', (_name, text) => {
        expect(text).toBeTruthy();
        expect(text).not.toContain('\n');
        expect(text).toMatch(/[.!?。！？]$/u);
        // One capitalisation rule: every part Happier words after " · " starts as a sentence does ("· Resets Wed …");
        // the Agent's own quoted words stay as written (startupRefusal's "stage=exec …").
        if (_name !== 'startupRefusal') for (const part of text!.split(' · ').slice(1)) expect(part[0]).toBe(part[0]!.toLocaleUpperCase());
    });

    it('puts what failed before its cause on the same line', () => {
        expect(rows.modelNotFound?.split(' · ')).toHaveLength(2);
        expect(rows.modelTransition?.split(' · ')).toHaveLength(2);
        // A sign-in refusal says what failed too, not only the step that fixes it (WAVE-ACCEPT-1117C).
        expect(rows.agentSignIn?.split(' · ')).toHaveLength(2);
        expect(rows.startupRefusal).toContain(' · stage=exec errno=EACCES');
    });
});

describe('unexplained runtime failure rows', () => {
    it('reads as the plain cause, not the Agent line with its raw diagnostic', () => {
        const raw = 'Claude Agent SDK process exited before emitting a result (exitCode=1): Error: Invalid MCP configuration: MCP config file not found: /tmp/happier-1000/happier-claude-mcp-config-28V9LT/payload.json';
        const normalized = normalizeRawMessage('rejected', 'rejected', 100, {
            role: 'agent', content: { type: 'acp', agentId: 'claude', data: { type: 'message', message: `Claude input rejected: ${raw}` } },
            meta: { source: 'runtime', runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed', code: 'agent_session_error',
                source: 'agent_session_error', occurredAt: 100, agentId: 'claude', sanitizedPreview: raw } },
        });
        const message = agent({ meta: normalized?.meta, text: `Claude input rejected: ${raw}` });
        const text = resolveTranscriptMessageDisplayText(message).text;
        expect(text).toBe(presentSessionRuntimeIssue(readRuntimeIssueMessageMeta(message.meta)).summary);
        expect(text).not.toContain('/tmp/');
    });
});
