import { describe, expect, it, vi } from 'vitest';
import {
    buildApprovalRequestArtifactHeaderV1,
    encodePasswordCredentialFieldV1,
    type ApprovalRequestV2,
} from '@happier-dev/protocol';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import {
    AgentsAcpBackendsUpsertOutputV1Schema,
    applyAcpBackendUpsertV1,
} from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';

import {
    createActionApprovalContinuation,
    createHomeActionApprovalContinuation,
} from './actionApprovalContinuation';

const actionId = 'teams.identity.connections.test.start' as const;
const actionInput = {
    v: 1 as const,
    teamId: 'team-1',
    connectionId: 'connection-1',
    expectedRevision: 2,
};
const actionResult = {
    attemptId: 'attempt-1',
    authorizeUrl: 'https://issuer.example.test/authorize',
};

type ReadableArtifact = Extract<DecryptedArtifact, Readonly<{ isDecrypted: true }>>;

function executedArtifact(overrides?: Readonly<{
    artifactId?: string;
    actionId?: ApprovalRequestV2['actionId'];
    actionArgs?: unknown;
    accountId?: string;
    serverId?: string;
    surface?: 'ui' | 'api' | 'cli' | 'plugin';
    requestedSurface?: string;
    requestId?: string;
    result?: unknown;
    preview?: unknown;
    executionOrigin?: ApprovalRequestV2['executionOriginV1'];
}>): ReadableArtifact {
    const requestActionId = overrides?.actionId ?? actionId;
    const request: ApprovalRequestV2 = {
        v: 2,
        status: 'executed',
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        requestedSurface: overrides?.requestedSurface ?? 'ui',
        executionOriginV1: overrides?.executionOrigin ?? {
            v: 1,
            authority: 'present_user',
            surface: overrides?.surface ?? 'ui',
            caller: { kind: 'host' },
            serverId: overrides?.serverId ?? 'home-1',
            accountId: overrides?.accountId ?? 'account-1',
            actionId: requestActionId,
            requestId: overrides?.requestId ?? 'request-1',
        },
        actionId: requestActionId,
        actionArgs: overrides?.actionArgs ?? actionInput,
        ...(overrides && 'preview' in overrides ? { preview: overrides.preview } : {}),
        summary: 'Test the Team identity connection',
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: {
            executedAtMs: 2,
            ok: true,
            result: overrides && 'result' in overrides ? overrides.result : actionResult,
        },
    };
    return {
        id: overrides?.artifactId ?? 'approval-1',
        title: null,
        header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request),
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        isDecrypted: true,
    };
}

function failedArtifact(overrides?: Readonly<{
    actionId?: ApprovalRequestV2['actionId'];
    actionArgs?: unknown;
    accountId?: string;
    errorCode?: string;
    error?: string;
    details?: unknown;
}>): ReadableArtifact {
    const requestActionId = overrides?.actionId ?? actionId;
    const request: ApprovalRequestV2 = {
        v: 2,
        status: 'failed',
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        requestedSurface: 'ui',
        executionOriginV1: {
            v: 1,
            authority: 'present_user',
            surface: 'ui',
            caller: { kind: 'host' },
            serverId: 'home-1',
            accountId: overrides?.accountId ?? 'account-1',
            actionId: requestActionId,
            requestId: 'request-1',
        },
        actionId: requestActionId,
        actionArgs: overrides?.actionArgs ?? actionInput,
        summary: 'Test the Team identity connection',
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: {
            executedAtMs: 2,
            ok: false,
            errorCode: overrides?.errorCode ?? 'identity_provider_unavailable',
            error: overrides?.error ?? overrides?.errorCode ?? 'identity_provider_unavailable',
            ...(overrides && 'details' in overrides ? { details: overrides.details } : {}),
        },
    };
    return {
        id: 'approval-1',
        title: null,
        header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request),
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        isDecrypted: true,
    };
}

describe('createHomeActionApprovalContinuation', () => {
    it('delivers an executed ACP receipt when transport omits native optional authoring members', async () => {
        // The mounted ACP editor explicitly sets auth to undefined for an agent without login.
        // The Home's JSON Artifact transport omits that optional native object member.
        const input = { backend: {
            id: 'custom-agent', name: 'custom-agent', title: 'Custom agent', command: 'custom-agent',
            args: [], env: {}, auth: undefined,
        }, expectedRevision: 1 };
        const mutation = applyAcpBackendUpsertV1({ settings: { v: 2, backends: [] }, backend: input.backend, nowMs: 2 });
        if (!mutation.ok) throw new Error(mutation.code);
        const result = { backend: mutation.backend };
        const artifact = executedArtifact({ actionId: 'agents.acp.backends.upsert', actionArgs: input, result });
        const terminal = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
        expect(terminal).toMatchObject({ family: 'built_in', request: { status: 'executed', execution: { ok: true } } });
        if (terminal?.family !== 'built_in') throw new Error('Invalid stored approval fixture');
        expect(AgentsAcpBackendsUpsertOutputV1Schema.safeParse(terminal.request.execution?.result).success).toBe(true);
        expect(terminal.request.actionArgs).toEqual({ backend: {
            id: 'custom-agent', name: 'custom-agent', title: 'Custom agent', command: 'custom-agent', args: [], env: {},
        }, expectedRevision: 1 });

        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({
            artifactId: artifact.id, actionId: 'agents.acp.backends.upsert',
            scope: { serverId: 'home-1', accountId: 'account-1' }, expectedInput: input, onSucceeded, onFailed,
        });
        expect(await continuation.onExecuted(artifact)).toBe('consumed');
        expect(onFailed).not.toHaveBeenCalled();
        expect(onSucceeded).toHaveBeenCalledWith(result);
    });
    it('delivers an exact immutable Agent terminal receipt and rejects altered origin facts', async () => {
        const terminalActionId = 'machines.terminal.restart' as const;
        const input = { serverId: 'home-1', machineId: 'machine-1', terminalKey: 'requester-owned', cwd: '/accepted',
            workspace: { serverId: 'home-1', workspaceId: 'accepted', machineId: 'machine-1', rootPath: '/accepted' } };
        const origin: ApprovalRequestV2['executionOriginV1'] = { v: 1, authority: 'account_automation', surface: 'agent',
            caller: { kind: 'host' }, serverId: 'home-1', accountId: 'account-1', actionId: terminalActionId, requestId: 'agent-restart' };
        const receipt = { ok: true, terminalId: 'requester-pty', reused: false };
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const create = () => createActionApprovalContinuation({ artifactId: 'approval-1', actionId: terminalActionId,
            scope: { serverId: 'home-1', accountId: 'account-1' }, expectedInput: input, expectedRequestId: origin.requestId,
            expectedExecutionOrigin: origin, onSucceeded, onFailed });
        const artifact = (executionOrigin: typeof origin) => executedArtifact({ actionId: terminalActionId, actionArgs: input,
            executionOrigin, requestedSurface: executionOrigin.surface, result: receipt });
        // This is the strict stored daemon receipt boundary, not an executor or
        // authority mock. The canonical Artifact header/body matcher is real.
        expect(await create().onExecuted(artifact(origin))).toBe('consumed');
        expect(onSucceeded).toHaveBeenCalledWith(receipt);
        expect(onFailed).not.toHaveBeenCalled();
        for (const changed of [{ ...origin, surface: 'voice' as const }, { ...origin, authority: 'present_user' as const },
            { ...origin, caller: { kind: 'session' as const, sessionId: 'other-agent', starterDepth: 0, turnDepth: 0 } }]) {
            onSucceeded.mockClear(); onFailed.mockClear();
            expect(await create().onExecuted(artifact(changed))).toBe('consumed');
            expect(onSucceeded).not.toHaveBeenCalled();
            expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
        }
    });
    it('delivers the exact executed result through the canonical Action output schema', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact())).toBe('consumed');
        expect(onSucceeded).toHaveBeenCalledWith(actionResult);
        expect(onFailed).not.toHaveBeenCalled();
    });

    it('ignores an Artifact with another identity without consuming the exact pending operation', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({ artifactId: 'approval-other' }))).toBe('ignored');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).not.toHaveBeenCalled();
    });

    it.each([
        ['wrong Action', executedArtifact({ actionId: 'teams.identity.connections.disable' })],
        ['wrong Account', executedArtifact({ accountId: 'account-other' })],
        ['wrong Home', executedArtifact({ serverId: 'home-other' })],
    ])('fails a same-Artifact %s binding instead of silently losing the result', async (_label, artifact) => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(artifact)).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
    });

    it('rejects the same Action when the approval belongs to different canonical input', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedInput: actionInput,
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({
            actionArgs: { ...actionInput, connectionId: 'connection-other' },
        }))).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
    });

    it('rejects the same Action when the approval belongs to another request identity', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedRequestId: 'request-1',
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({ requestId: 'request-other' }))).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
    });

    it.each([
        ['non-UI origin', executedArtifact({ surface: 'api' })],
        ['non-UI requested surface', executedArtifact({ requestedSurface: 'api' })],
    ])('rejects a structurally contradictory %s artifact as invalid', async (_label, artifact) => {
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded: vi.fn(),
            onFailed,
        });

        expect(await continuation.onExecuted(artifact)).toBe('consumed');
        expect(onFailed).toHaveBeenCalledWith('approval_invalid');
    });

    it('fails a malformed exact Artifact as invalid', async () => {
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded: vi.fn(),
            onFailed,
        });
        const artifact = executedArtifact();

        expect(await continuation.onExecuted({ ...artifact, body: '{' })).toBe('consumed');
        expect(onFailed).toHaveBeenCalledWith('approval_invalid');
    });

    it('reports an invalid recorded result without manufacturing success', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({ result: { v: 1 } }))).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('invalid_action_output');
    });

    it('preserves the exact failed execution code after validating the same Action binding', () => {
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded: vi.fn(),
            onFailed,
        });

        continuation.onTerminal?.('failed', failedArtifact());
        expect(onFailed).toHaveBeenCalledWith('identity_provider_unavailable', {
            ok: false,
            errorCode: 'identity_provider_unavailable',
            error: 'identity_provider_unavailable',
        });

        onFailed.mockClear();
        continuation.onTerminal?.('failed', failedArtifact({ actionId: 'teams.identity.connections.disable' }));
        expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
    });
});

describe('createActionApprovalContinuation', () => {
    it('delivers strict deferred Board failure details through the canonical failure envelope', () => {
        const boardActionId = 'session.board.layout.update' as const;
        const boardInput = {
            sessionId: 'session-1',
            expectedLayoutRevision: null,
            operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
        };
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId: boardActionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedInput: boardInput,
            onSucceeded: vi.fn(),
            onFailed,
        });

        continuation.onTerminal?.('failed', failedArtifact({
            actionId: boardActionId,
            actionArgs: boardInput,
            errorCode: 'session_board_revision_conflict',
            details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
        }));

        expect(onFailed).toHaveBeenCalledWith(
            'session_board_revision_conflict',
            {
                ok: false,
                errorCode: 'session_board_revision_conflict',
                error: 'session_board_revision_conflict',
                details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
            },
        );
    });

    it('settles a live-only-custody Action whose durable record carries only the observation projection', async () => {
        // `account.password.enroll` declares `approvalInputCustody: 'live_only'`,
        // so the executor records the Action's own observation projection — not
        // the credential, verification bearer or reauthentication proof the
        // caller holds. The continuation must still recognise its own approval.
        const enrollActionId = 'account.password.enroll' as const;
        const enrollInput = {
            v: 1 as const,
            kind: 'plain' as const,
            email: 'person@example.test',
            targetCredential: {
                v: 1 as const,
                kind: 'plain_password_hash' as const,
                hash: {
                    v: 1 as const,
                    algorithm: 'scrypt' as const,
                    parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
                    salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
                    digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
                },
            },
            verificationToken: 'A'.repeat(43),
            reauthentication: { provider: 'github', pending: 'pending-1', proof: 'proof-1' },
        };
        const observedEnrollInput = { v: 1, kind: 'plain' } as const;
        const enrollResult = { v: 1 as const, status: 'enrolled' as const };
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId: enrollActionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedInput: enrollInput,
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({
            actionId: enrollActionId,
            actionArgs: observedEnrollInput,
            preview: { actionId: enrollActionId, actionArgs: observedEnrollInput },
            result: enrollResult,
        }))).toBe('consumed');
        expect(onFailed).not.toHaveBeenCalled();
        expect(onSucceeded).toHaveBeenCalledWith(enrollResult);
    });

    it('still refuses a projecting Action whose observed input names another resource', async () => {
        // Everything the projection keeps — owner, id, revision — still binds.
        // Only the redacted secret itself stops distinguishing two approvals.
        const replaceActionId = 'identity.providers.secret.replace' as const;
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId: replaceActionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedInput: {
                owner: { kind: 'home' },
                id: 'provider-1',
                expectedRevision: 3,
                clientSecret: 'client-secret-value',
            },
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({
            actionId: replaceActionId,
            actionArgs: { owner: { kind: 'home' }, id: 'provider-other', expectedRevision: 3 },
            preview: {
                actionId: replaceActionId,
                actionArgs: { owner: { kind: 'home' }, id: 'provider-other', expectedRevision: 3 },
            },
            result: { outcome: 'removed' },
        }))).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
    });

    it('settles an exact non-Home-domain Action through its canonical Action output schema', async () => {
        const boardActionId = 'session.board.layout.update' as const;
        const boardInput = {
            sessionId: 'session-1',
            expectedLayoutRevision: null,
            operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
        };
        const boardResult = {
            v: 1 as const,
            serverId: 'home-1',
            sessionId: 'session-1',
            result: {
                operation: 'update_layout' as const,
                outcome: 'created' as const,
                layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
            },
            destination: null,
        };
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId: boardActionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedInput: boardInput,
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({
            actionId: boardActionId,
            actionArgs: boardInput,
            result: boardResult,
        }))).toBe('consumed');
        expect(onSucceeded).toHaveBeenCalledWith(boardResult);
        expect(onFailed).not.toHaveBeenCalled();
    });
});
