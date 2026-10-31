import { beforeEach, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createUiApprovalRequest, installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ApprovalRequestSchema, ApprovalRequestV2Schema, API_TOKEN_FULL_GRANT_V1, ARTIFACT_PLAIN_DATA_KEY_MARKER, buildApprovalRequestArtifactHeaderV1, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { presentApprovalFailure, useApprovalDecisionHandler } = await import('./useApprovalDecisionHandler');

describe('built-in approval decisions through the canonical owner', () => {
    it.each([
        ['runtime_action_disabled', 'runtime_action_disabled:browser:browser_automation_runtime_provisioning'],
        ['target_unavailable', 'target_unavailable'],
    ])('keeps %s diagnostics out of the human-facing failure fallback', (errorCode, error) => {
        expect(presentApprovalFailure({ errorCode, error }, error))
            .toEqual({ reason: t('approvals.decisionError'), code: errorCode });
    });
    it('keeps the readable reason apart from its typed code for every Action', () => {
        const failure = { errorCode: 'sandbox_unavailable', error: 'Managed Chromium sandbox is unavailable. Allow it once.' };
        expect(presentApprovalFailure(failure, failure.error)).toEqual({ reason: failure.error, code: 'sandbox_unavailable' });
        // Typed copy that already names the problem carries no code to show.
        expect(presentApprovalFailure({ errorCode: 'approval_stale', error: 'x' }, 'x')).toEqual({ reason: t('approvals.staleFailure'), code: null });
    });
    it.each([
        'database_connection_unavailable',
        'database_transaction_conflict_exhausted',
        'project_requester_home_unavailable',
    ])('reads the transient availability failure %s as a busy server that changed nothing, keeping the code for details', (errorCode) => {
        expect(presentApprovalFailure({ errorCode, error: errorCode }, errorCode))
            .toEqual({ reason: t('approvals.transientFailure'), code: errorCode });
        expect(presentApprovalFailure(new HappyError('transport detail', false, { code: errorCode })))
            .toEqual({ reason: t('approvals.transientFailure'), code: errorCode });
    });
    it('retains the exact typed failure code in the shared decision failure presentation', () => {
        expect(presentApprovalFailure(new HappyError('private transport detail', false,
            { code: 'approval_origin_unavailable' }))).toEqual({ reason: t('approvals.decisionError'), code: 'approval_origin_unavailable' });
        expect(presentApprovalFailure(new Error('private transport detail'))).toEqual({ reason: t('approvals.decisionError'), code: null });
        expect(presentApprovalFailure(new HappyError('private transport detail', false,
            { code: 'present_user_required' })).reason).toBe(t('approvals.decisionAuthorityError'));
    });
    it('reports exact-daemon route refusal with its code before recording a Machine decision', async () => {
        const serverId = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://missing-replay.test', accountId: 'bob' });
        const request = ApprovalRequestSchema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'source' }, requestedSurface: 'agent',
            actionId: 'session.stop', actionArgs: { sessionId: 'source' }, summary: 'Stop session',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
                caller: { kind: 'session', sessionId: 'source', starterDepth: 0, turnDepth: 0 },
                serverId, machineId: 'missing-machine', actionId: 'session.stop', requestId: 'missing-route' } });
        const artifact = { id: 'missing-route-approval', header: buildApprovalRequestArtifactHeaderV1(request) };
        const hook = await renderHook(() => useApprovalDecisionHandler(artifact, request, 'source', serverId));
        try {
            await expect(hook.getCurrent()('approve')).rejects.toMatchObject({ code: 'approval_origin_unavailable' });
            expect(harness.requests.filter(({ path }) => path.includes('/rpc'))).toEqual([]);
        } finally { await hook.unmount(); }
    });
    beforeEach(async () => { standardCleanup(); await harness.reset(); });
    it('recovers a lost daemon decision receipt from the public approval projection without replay authority', async () => {
        const serverId = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://approval-settlement.test',
            serverIdentityId: 'srv_approval-settlement', accountId: 'bob', currentAccount: true });
        await installOwnMachineApprovalReplayBoundary({ harness, serverId, accountId: 'bob', machineId: 'machine' });
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'source' }, requestedSurface: 'agent',
            // APPR-S1 step 2: Account title edits replay in the app; archive
            // remains Session-placed and exercises the exact-daemon receipt.
            actionId: 'session.archive', actionArgs: { sessionId: 'source' }, summary: 'Archive session',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'api', caller: { kind: 'host' },
                serverId, serverIdentityId: 'srv_approval-settlement', accountId: 'bob', principalId: 'principal', credentialId: 'credential',
                machineId: 'machine', sessionId: 'source', target: { kind: 'session', sessionId: 'source' },
                actionId: 'session.archive', requestId: 'title-request', externalActionInputSignature: 'a'.repeat(86),
                externalActionExecutionAuthorization: { v: 1, token: 'synthetic-private-daemon-authorization', binding: {
                    serverIdentityId: 'srv_approval-settlement', accountId: 'bob', principalId: 'principal', credentialId: 'credential',
                    grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine', custodianAccountId: 'bob', installationId: 'machine-installation',
                    actionId: 'session.archive', requestId: 'title-request', requestEnvelopeDigest: 'a'.repeat(43),
                    target: { kind: 'session', sessionId: 'source' },
                } },
            } });
        const artifact = { id: 'lost-title-receipt', header: buildApprovalRequestArtifactHeaderV1(request) };
        await harness.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            ...artifact, header: encodePlainArtifactStoredContent(artifact.header),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        // The daemon is the process boundary: it committed a valid settlement
        // before the HTTP caller lost its receipt. The public reader remains real.
        harness.answer(serverId, '/v1/actions/approval.request.decide', { select: async input => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
            const settled = ApprovalRequestV2Schema.parse({ ...request, status: 'executed', updatedAtMs: 3,
                decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} } });
            const context = await captureActionAccountContext(serverId);
            try {
                // The deciding executor already persisted consent. Use the
                // actual current revision and Artifact codec for settlement,
                // rather than silently losing a hard-coded revision-1 CAS.
                const basis = await context.fetchArtifact(artifact.id);
                if (!basis) throw new Error('Expected the approval before daemon settlement');
                await context.updateArtifact(artifact.id, buildApprovalRequestArtifactHeaderV1(settled), JSON.stringify(settled), basis);
                const persisted = await context.fetchArtifact(artifact.id);
                expect(persisted?.isDecrypted).toBe(true);
                expect(approvalArtifactBodyMatchesHeaderV1(persisted?.header ?? {},
                    typeof persisted?.body === 'string' ? persisted.body : null)?.request.status).toBe('executed');
            } finally { context.dispose(); }
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide', requestId: envelope.requestId,
                execution: { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' } }) };
        } });
        const hook = await renderHook(() => useApprovalDecisionHandler(artifact, request, 'source', serverId));
        try {
            await expect(hook.getCurrent()('approve')).resolves.toBe(true);
            expect(harness.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1);
            expect(harness.artifacts(serverId).readPlainBody(artifact.id)).toContain('synthetic-private-daemon-authorization');
        } finally { await hook.unmount(); }
    });
    it('preserves a typed effect refusal after the approval decision was recorded', async () => {
        const serverId = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://effect-failure.test',
            accountId: 'bob', teamsEnabled: true });
        await harness.requireUiApproval(serverId, 'teams.update');
        harness.answer(serverId, '/v1/teams/update', { status: 409, body: { error: 'team_archived' } });
        const artifactId = await createUiApprovalRequest({ serverId, actionId: 'teams.update',
            actionInput: { v: 1, teamId: 'team-1', name: 'Garden' }, actionRequestId: 'rename-effect-refused' });
        const context = await captureActionAccountContext(serverId);
        try {
            const artifact = await context.fetchArtifact(artifactId);
            if (!artifact || typeof artifact.body !== 'string') throw new Error('Expected pending approval');
            const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
            if (parsed?.family !== 'built_in') throw new Error('Expected built-in approval');
            const hook = await renderHook(() => useApprovalDecisionHandler(artifact, parsed.request, '', serverId));
            try {
                const failure: unknown = await hook.getCurrent()('approve').catch((error: unknown) => error);
                expect(failure).toMatchObject({ code: 'team_archived' });
                expect(presentApprovalFailure(failure).code).toBe('team_archived');
                expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null')).toMatchObject({
                    status: 'failed', decision: { kind: 'approve' }, execution: { ok: false, errorCode: 'team_archived' },
                });
            } finally { await hook.unmount(); }
        } finally { context.dispose(); }
    });
    it('reports a durably stale V2 execution with its typed rejection', async () => {
        const serverId = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://stale-effect.test',
            accountId: 'bob', teamsEnabled: true });
        await harness.requireUiApproval(serverId, 'teams.update');
        const artifactId = await createUiApprovalRequest({ serverId, actionId: 'teams.update',
            actionInput: { v: 1, teamId: 'team-1', name: 'Garden' }, actionRequestId: 'stale-effect' });
        const request = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!));
        // The daemon/other app already settled the request. Store its receipt
        // at the Home boundary; an arbitrary HTTP409 is a Home conflict, not
        // proof of an approval-domain stale execution.
        const settled = ApprovalRequestV2Schema.parse({ ...request, status: 'failed', updatedAtMs: request.updatedAtMs + 2,
            decision: { kind: 'approve', decidedAtMs: request.updatedAtMs + 1 },
            execution: { executedAtMs: request.updatedAtMs + 2, ok: false, errorCode: 'approval_stale', error: 'approval_stale' },
        });
        const context = await captureActionAccountContext(serverId);
        try {
            const basis = await context.fetchArtifact(artifactId);
            if (!basis) throw new Error('Expected the approval before settlement');
            await context.updateArtifact(artifactId, buildApprovalRequestArtifactHeaderV1(settled), JSON.stringify(settled), basis);
        } finally { context.dispose(); }
        const hook = await renderHook(() => useApprovalDecisionHandler({ id: artifactId, header: null }, settled, '', serverId));
        try {
            const decision = hook.getCurrent()('approve');
            await expect(decision).rejects.toMatchObject({ code: 'approval_stale', canTryAgain: false });
            const failure: unknown = await decision.catch((error: unknown) => error);
            expect(presentApprovalFailure(failure).reason).toBe(t('approvals.staleFailure'));
            expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!)).toMatchObject({
                status: 'failed', decision: { kind: 'approve' }, execution: { ok: false, errorCode: 'approval_stale' },
            });
            expect(harness.requestsFor('/v1/teams/update')).toHaveLength(0);
        } finally { await hook.unmount(); }
    });
    it('leaves a legacy request open without recording consent or attempting an effect', async () => {
        const serverId = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://stale-approval.test', accountId: 'bob' });
        const request = ApprovalRequestSchema.parse({
            v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'mcp' }, requestedSurface: 'mcp',
            actionId: 'session.spawn_new', summary: 'Create session', serverId,
            actionArgs: { creationKey: 'api:stale-directory', executionTarget: { serverId, machineId: 'machine' },
                directory: '/repo/new', organizationPlacement: { folderId: null, tagIds: [] },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                initialInput: { text: 'Inspect this repository.' } },
            sessionCreationDirectoryApproval: { v: 1, executionTarget: { serverId, machineId: 'machine' }, directory: '/repo/new' },
        });
        const artifact = { id: 'stale-approval', header: buildApprovalRequestArtifactHeaderV1(request) };
        const response = await harness.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            ...artifact, header: encodePlainArtifactStoredContent(artifact.header),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        expect(response?.ok).toBe(true);
        const hook = await renderHook(() => useApprovalDecisionHandler(artifact, request, '', serverId));
        // APPROVALS-SIMPLIFY step 2 resolves V1 as legacy/unavailable before
        // consent; it no longer manufactures a failed execution receipt.
        await expect(hook.getCurrent()('approve')).resolves.toBe(false);
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifact.id) ?? 'null')).toEqual(request);
        expect(harness.requests.filter(({ path }) => path.includes('/rpc'))).toEqual([]);
        await hook.unmount();
    });
    it('cancels a real pending Machine open without running the physical effect', async () => {
        const serverId = await harness.addHome({ name: 'Terminal Home', serverUrl: 'https://terminal-cancel.test',
            serverIdentityId: 'srv_terminal-cancel', accountId: 'bob', currentAccount: true });
        harness.answer(serverId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] } });
        await harness.requireUiApproval(serverId, 'machines.terminal.open');
        const artifactId = await createUiApprovalRequest({ serverId, actionId: 'machines.terminal.open',
            actionInput: { serverId, machineId: 'machine', terminalKey: 'owned-member', cwd: '/accepted' }, actionRequestId: 'open-own-member' });
        const context = await captureActionAccountContext(serverId);
        try {
            const artifact = await context.fetchArtifact(artifactId);
            if (!artifact || typeof artifact.body !== 'string') throw new Error('Expected actual pending Artifact');
            const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
            if (parsed?.family !== 'built_in') throw new Error('Expected built-in approval');
            const hook = await renderHook(() => useApprovalDecisionHandler(artifact, parsed.request, '', serverId));
            expect(await hook.getCurrent()('cancel')).toBe(true);
            const canceled = harness.artifacts(serverId).readPlainBody(artifactId);
            expect(canceled && JSON.parse(canceled)).toMatchObject({ status: 'canceled' });
            expect(canceled && JSON.parse(canceled)).not.toHaveProperty('decision');
            expect(harness.requests.filter(request => request.path.includes('/rpc'))).toEqual([]);
            await hook.unmount();
        } finally { context.dispose(); }
    });
});
