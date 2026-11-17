import { describe, expect, it } from 'vitest';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { isRuntimeIssueMessageMeta, readRuntimeIssueMessageMeta } from '../transcript/events/runtimeIssueMessage';

import { t } from '@/text';

import { presentSessionTeamCredentialDenial } from './sessionTeamCredentialDenialPresentation';

function runtimeIssue(patch: Partial<SessionRuntimeIssueV1>): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'team_credential',
        source: 'team_credential',
        occurredAt: 1_700_000_000_000,
        sanitizedPreview: 'Shared Team credential refused the request',
        ...patch,
    } as SessionRuntimeIssueV1;
}

const resourceNames: Readonly<Record<string, string>> = { 'resource-acme': 'Acme OpenAI' };
const resolveResourceDisplayName = (resourceId: string) => resourceNames[resourceId] ?? null;

describe('presentSessionTeamCredentialDenial', () => {
    it('preserves reconnect recovery from the real retained transcript reader', () => {
        const issue = runtimeIssue({ teamCredential: {
            v: 1, resourceId: 'resource-acme', reasonCode: 'connected_service_credential_reconnect_required',
        } });
        const message = normalizeRawMessage('failure', 'failure', issue.occurredAt, {
            role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
                type: 'message', message: issue.sanitizedPreview,
            } }, meta: { source: 'runtime', runtimeIssueV1: issue },
        }, { seq: 10 });
        const presentation = presentSessionTeamCredentialDenial({
            issue: readRuntimeIssueMessageMeta(message?.meta), resolveResourceDisplayName,
        });
        expect(presentation?.title).toBe('Connected account needs reconnect');
        expect(presentation?.body).toContain(t('teams.credentials.recovery.ownerHandoff'));
        expect(presentation?.body).toContain('Acme OpenAI');
        // The row reads `title · body`: the body continues the title, it never says it again.
        expect(presentation?.body).not.toContain(presentation?.title);
    });
    it('selects the named refusal and recovery from the common owner/shared-editor history reader without owner metadata', () => {
        const issue = runtimeIssue({ teamCredential: {
            v: 1, resourceId: 'resource-acme', reasonCode: 'resource_forbidden',
        } });
        const message = normalizeRawMessage('failure', 'failure', issue.occurredAt, {
            role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
                type: 'message', message: issue.sanitizedPreview,
            } }, meta: { source: 'runtime', runtimeIssueV1: issue },
        }, { seq: 10 });
        // Both roles receive the same authorized transcript, even when the
        // mutable Session issue/owner-only binding projection is unavailable.
        expect(isRuntimeIssueMessageMeta(message?.meta)).toBe(true);
        const presentation = presentSessionTeamCredentialDenial({
            issue: readRuntimeIssueMessageMeta(message?.meta),
            resolveResourceDisplayName,
        });
        expect(presentation).toMatchObject({ kind: 'team-credential-denied', resourceId: 'resource-acme',
            action: 'choose-model', actionLabel: 'Choose another credential' });
        expect(presentation?.body).toContain('Acme OpenAI');
        expect(presentation?.body).toContain('managed by this Team');
    });

    it('names the exhausted shared credential, its measure and when the allowance returns', () => {
        const presentation = presentSessionTeamCredentialDenial({
            issue: runtimeIssue({
                teamCredential: {
                    v: 1,
                    resourceId: 'resource-acme',
                    reasonCode: 'team_credential_usage_limit',
                    usageLimit: { metric: 'total_tokens', remaining: '0', resetsAtUtc: '2026-10-01T00:00:00.000Z' },
                },
            }),
            resolveResourceDisplayName,
        });

        // Without every one of these the member is back at the sanitized preview
        // and cannot tell which credential refused or when it reopens.
        expect(presentation?.title).toBe('A shared credential refused this request');
        expect(presentation?.body).toContain('Acme OpenAI');
        expect(presentation?.body).toContain('Limit reached');
        expect(presentation?.body).toContain('Tokens');
        expect(presentation?.body).toContain('Resets');
        expect(presentation?.action).toBe('choose-model');
        expect(presentation?.actionLabel).toBe('Choose another credential');
    });

    it('reads a structural refusal in the credential surfaces’ own words and names no limit', () => {
        const presentation = presentSessionTeamCredentialDenial({
            issue: runtimeIssue({
                teamCredential: { v: 1, resourceId: 'resource-acme', reasonCode: 'broker_unavailable' },
            }),
            resolveResourceDisplayName,
        });

        expect(presentation?.body).toContain('Acme OpenAI');
        expect(presentation?.body).toContain('broker machine for this credential is not reachable');
        expect(presentation?.body).not.toContain('Resets');
    });

    it('still reports a refusal a custodian too old to name its resource relayed', () => {
        const presentation = presentSessionTeamCredentialDenial({
            issue: runtimeIssue({}),
            resolveResourceDisplayName,
        });

        expect(presentation?.title).toBe('A shared credential refused this request');
        expect(presentation?.body).toBeUndefined();
        expect(presentation?.resourceId).toBeNull();
    });

    it('leaves a resource this viewer cannot name unattributed instead of printing its id', () => {
        const presentation = presentSessionTeamCredentialDenial({
            issue: runtimeIssue({
                teamCredential: { v: 1, resourceId: 'resource-unknown', reasonCode: 'resource_forbidden' },
            }),
            resolveResourceDisplayName,
        });

        expect(presentation?.body).not.toContain('resource-unknown');
        expect(presentation?.body).toContain('managed by this Team');
    });

    it('answers nothing for a runtime issue another owner presents', () => {
        expect(presentSessionTeamCredentialDenial({
            issue: runtimeIssue({ source: 'usage_limit', code: 'usage_limit' }),
            resolveResourceDisplayName,
        })).toBeNull();
        expect(presentSessionTeamCredentialDenial({ issue: null, resolveResourceDisplayName })).toBeNull();
    });
});
