import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountSettingsV2UpdateRequestSchema, ApprovalRequestSchema, BUILT_IN_ROLES_V1 } from '@happier-dev/protocol';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit';
import { t } from '@/text';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

describe('present-user UI approval origin at the Action host', () => {
    beforeEach(() => harness.reset());
    afterEach(() => standardCleanup());

    it.each([
        { actionId: 'roles.create', credential: 'account' },
        { actionId: 'artifact.access.grants.set', credential: 'account' },
        { actionId: 'roles.create', credential: 'terminal' },
        { actionId: 'artifact.access.grants.set', credential: 'terminal' },
    ] as const)(
        'admits $actionId with $credential credentials without caller-authored provenance', async ({ actionId, credential }) => {
            const serverId = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://ui-origin.test', accountId: 'alice' });
            let raw: Record<string, unknown> = {};
            let version = 0;
            // Role creation also migrates Account settings. Persist the real
            // HTTP CAS winner instead of answering a write with a read response.
            const settingsAnswer = { select: (input: unknown) => {
                if (input === null || input === undefined) return { body: { content: { t: 'plain', v: raw }, version } };
                const request = AccountSettingsV2UpdateRequestSchema.parse(input);
                if (request.expectedVersion !== version) return { body: { success: false, error: 'version-mismatch', currentVersion: version,
                    currentContent: { t: 'plain', v: raw } } };
                if (request.content?.t !== 'plain') throw new Error('Expected Plain Account settings');
                raw = request.content.v;
                return { body: { success: true, version: ++version } };
            } };
            harness.answer(serverId, '/v2/account/settings', settingsAnswer);
            const executor = createDefaultActionExecutor();
            if (actionId === 'artifact.access.grants.set') {
                const seeded = await executor.execute('roles.create', { roleId: 'shared-role', role: BUILT_IN_ROLES_V1.builder }, { serverId });
                expect(seeded, JSON.stringify(seeded))
                    .toMatchObject({ ok: true, result: { roleId: 'shared-role' } });
                const projection = { artifactId: 'shared-role', ownerAccountId: 'alice', access: 'owner', grants: [] };
                harness.answer(serverId, 'GET /v1/artifacts/shared-role/access/grants', { body: projection });
                harness.answer(serverId, 'PUT /v1/artifacts/shared-role/access/grants', { body: {
                    ...projection, changed: true, grants: [{ principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view',
                        createdByAccountId: 'alice', createdAt: 1, display: { name: 'Bob' } }],
                } });
            }
            await harness.requireUiApproval(serverId, actionId);
            raw = { ...raw, actionsSettingsV1: { v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } } };
            version += 1;
            harness.answer(serverId, '/v2/account/settings', settingsAnswer);
            if (credential === 'terminal') {
                const home = harness.findByServerUrl('https://ui-origin.test');
                if (!home) throw new Error('Home missing');
                // A structural bearer at the credential-store boundary; the real
                // provenance decoder and authority owner remain under test.
                home.token = `e30.${btoa(JSON.stringify({ sub: 'alice', session: 'terminal-test', provenance: {
                    v: 2, kind: 'terminal', authority: 'account_automation',
                    evidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
                } }))}.signature`;
            }
            const input = actionId === 'roles.create'
                ? { roleId: 'new-role', role: BUILT_IN_ROLES_V1.builder }
                : { artifactId: 'shared-role', principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view' };
            // Exactly the UI caller contract: no authority, Account or request id.
            if (credential === 'terminal') {
                const controller = new AbortController();
                // Automation keeps the policy-owned blocking waiter. Observe durable
                // custody before cancelling this test's invocation; do not waive policy.
                const pending = executor.execute(actionId, input, { surface: 'ui', serverId, signal: controller.signal });
                try {
                    const created = await waitForHomeGovernance(() => {
                        const approval = harness.artifacts(serverId).list().find((row) => {
                            const body = harness.artifacts(serverId).readPlainBody(row.id);
                            return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
                        });
                        expect(approval).toBeDefined();
                        return approval!;
                    });
                    const request = ApprovalRequestSchema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(created.id) ?? 'null'));
                    expect(request).toMatchObject({ v: 2, status: 'open', actionId, executionOriginV1: {
                        authority: 'account_automation', surface: 'ui', serverId, accountId: 'alice', caller: { kind: 'host' },
                    } });
                    if (request.v !== 2) throw new Error('Expected durable approval provenance');
                    expect(request.executionOriginV1.requestId).not.toBe('');
                    const { getApprovalDecisionErrorMessage, useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
                    const hook = await renderHook(() => useApprovalDecisionHandler({ id: created.id, header: null }, request, '', serverId));
                    const decision = hook.getCurrent()('approve');
                    await expect(decision).rejects.toMatchObject({ code: 'present_user_required' });
                    const failure: unknown = await decision.catch((error: unknown) => error);
                    expect(getApprovalDecisionErrorMessage(failure)).toBe(t('approvals.decisionAuthorityError'));
                    expect(getApprovalDecisionErrorMessage(failure)).not.toBe(t('approvals.decisionError'));
                    expect(JSON.parse(harness.artifacts(serverId).readPlainBody(created.id) ?? 'null')).toMatchObject({ status: 'open' });
                    expect(harness.artifacts(serverId).readPlainBody('new-role')).toBeNull();
                    expect(harness.requests.some(({ path }) => path.endsWith('/access/grants'))).toBe(false);
                } finally {
                    controller.abort();
                    await pending;
                }
                return;
            }
            const result = await executor.execute(actionId, input, { surface: 'ui', serverId });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            if (!result.ok) throw new Error(result.error);
            const created = result.result as { artifactId: string };
            const body = harness.artifacts(serverId).readPlainBody(created.artifactId);
            if (body === null) throw new Error('Approval Artifact was not persisted');
            const request = ApprovalRequestSchema.parse(JSON.parse(body));
            expect(request).toMatchObject({ v: 2, actionId, status: 'open', executionOriginV1: {
                authority: 'present_user',
                surface: 'ui', serverId, accountId: 'alice', caller: { kind: 'host' },
            } });
            if (request.v !== 2) throw new Error('Expected durable approval provenance');
            expect(request.executionOriginV1.requestId).not.toBe('');
            expect(harness.requests.some(({ path }) => path.endsWith('/access/grants'))).toBe(false);
            expect(harness.artifacts(serverId).readPlainBody('new-role')).toBeNull();
            const decision = await executor.execute('approval.request.decide', { artifactId: created.artifactId, decision: 'approve' }, { surface: 'ui', serverId });
            expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
            if (actionId === 'roles.create') {
                expect(JSON.parse(harness.artifacts(serverId).readPlainBody('new-role') ?? 'null')).toMatchObject({ name: BUILT_IN_ROLES_V1.builder.name });
            } else {
                expect(harness.requestsFor('/v1/artifacts/shared-role/access/grants').filter(({ input }) => input !== null).map(({ input }) => input))
                    .toEqual([{ artifactId: 'shared-role', principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view' }]);
            }
        },
    );

    it('preserves an existing request identity through prepared UI approval admission', async () => {
        const serverId = await harness.addHome({ name: 'Prepared Home', serverUrl: 'https://prepared-origin.test', accountId: 'alice' });
        await harness.requireUiApproval(serverId, 'roles.create');
        const prepared = await createDefaultActionExecutor().prepare('roles.create', {
            roleId: 'prepared-role', role: BUILT_IN_ROLES_V1.builder,
        }, { serverId, actionRequestId: 'stable-human-request' });
        expect(prepared).toMatchObject({ kind: 'settled', result: { ok: true, result: { kind: 'approval_request_created' } } });
        const request = ApprovalRequestSchema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(harness.artifacts(serverId).list()[0]!.id) ?? 'null'));
        expect(request).toMatchObject({ v: 2, executionOriginV1: { authority: 'present_user', requestId: 'stable-human-request', accountId: 'alice' } });
    });

    it('refuses an unscoped UI approval when no active Account runtime is available', async () => {
        const serverId = await harness.addHome({ name: 'Unavailable Home', serverUrl: 'https://unavailable-origin.test', accountId: 'alice' });
        await harness.requireUiApproval(serverId, 'artifact.access.grants.set');
        const result = await createDefaultActionExecutor().execute('artifact.access.grants.set', {
            artifactId: 'shared-role', principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view',
        }, { surface: 'ui' });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it('does not promote an Agent caller that claims present-user authority', async () => {
        const serverId = await harness.addHome({ name: 'Agent Home', serverUrl: 'https://agent-origin.test', accountId: 'alice' });
        const result = await createDefaultActionExecutor().execute('artifact.access.grants.set', {
            artifactId: 'shared-role', principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view',
        }, { surface: 'agent', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });
});
