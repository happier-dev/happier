import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { parseToken } from '@/utils/auth/parseToken';
import { encodeBase64 } from '@/encryption/base64';
import nacl from 'tweetnacl';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSuggestionFixture>>;
await prepareSessionFilesViewTestkit();
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

function pendingStart(runId: string) {
    return ExecutionRunStartResponseSchema.parse({ runId, callId: 'call', sidechainId: 'sidechain',
        wait: { ok: true, status: 'running', disposition: 'observation_timeout', runId,
            timeoutMs: 12_000, observedAtMs: 13_000, deadlineAtMs: 13_000 } });
}

/** Home HTTP and daemon RPC are the boundaries; requester sealing/admission stays real. */
async function createSuggestionFixture(input: Readonly<{
    start(): ReturnType<typeof pendingStart>;
    rpc: NonNullable<Parameters<typeof createSessionFilesViewFixture>[0]>['rpc'];
}>) {
    const serverIdentityId = 'srv_commit_suggestion';
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
    const startRequests: unknown[] = [];
    const request: NonNullable<NonNullable<Parameters<typeof createSessionFilesViewFixture>[0]>['request']> = async (url, init) => {
        const path = new URL(String(url)).pathname;
        const authorization = new Headers(init?.headers).get('Authorization');
        const accountId = authorization?.startsWith('Bearer ') ? parseToken(authorization.slice(7)) : null;
        if ((path === '/v1/machines' || path === '/v1/machines/m1' || path === '/v1/machines/read-batch') && accountId) {
            const machine = { ...createPlainMachineRowFixture({ id: 'm1', accountId }),
                installationId: 'suggestion-installation', installationPublicKey: encodeBase64(installation.publicKey) };
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
                return createMachineReadBatchResponseFixture(init.body, id => id === machine.id ? machine : null);
            }
            return Response.json(path === '/v1/machines' ? [machine] : { machine });
        }
        if (path === '/v1/actions/execution.run.start/execution-authorization' && accountId) {
            const mint = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-authorization', binding: {
                accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 0 },
                accountEncryptionMode: 'plain', serverIdentityId, machineId: 'm1', installationId: 'suggestion-installation',
                actionId: 'execution.run.start', requestId: mint.envelope.requestId, target: mint.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(mint.envelope),
            } }));
        }
        if (path === '/v1/actions/execution.run.start') {
            const mint = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            startRequests.push(mint.envelope);
            return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1,
                actionId: 'execution.run.start', requestId: mint.envelope.requestId,
                execution: { ok: true, result: input.start() },
            }));
        }
        return null;
    };
    const owner = await createSessionFilesViewFixture({ rpc: call => {
        if (call.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
        // The Action executor composes observation after the native Home start;
        // it deliberately does not trust a start receipt as a waiter result.
        if (call.method === SESSION_RPC_METHODS.EXECUTION_RUN_WAIT) {
            const { runId } = call.payload as { runId: string };
            return pendingStart(runId).wait;
        }
        return input.rpc?.(call);
    }, request, serverIdentityId,
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) } });
    return { ...owner, startRequests, suggestionRequest: request };
}

describe('shared commit suggestion Run custody', () => {
    it('does not disclose a held old-Account result or clear the new Account pending Run', async () => {
        const { createDeferred, flushHookEffects } = await import('@/dev/testkit');
        const held = createDeferred<unknown>();
        let starts = 0;
        const output = (runId: string) => ({ run: { runId, callId: 'call', sidechainId: 'sidechain', intent: 'scm_commit_message',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'no_tools', retentionPolicy: 'ephemeral',
            runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 },
            latestToolResult: { message: runId === 'old' ? 'private old Account message' : 'new Account message' } });
        fixture = await createSuggestionFixture({ start: () => pendingStart(++starts === 1 ? 'old' : 'new'), rpc: request => {
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return (request.payload as { runId: string }).runId === 'old' ? held.promise : output('new');
            return undefined;
        } });
        const settings = { scmCommitMessageGeneratorEnabled: true, scmCommitMessageGeneratorRunnerV1: { v: 1 as const, modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'default' } } };
        fixture.storage.getState().applySettingsLocal(settings);
        const { useScmCommitMessageSuggestion } = await import('./useScmCommitMessageSuggestion');
        let suggestion: ReturnType<typeof useScmCommitMessageSuggestion> | null = null;
        function Host() { suggestion = useScmCommitMessageSuggestion({ kind: 'workspace', workspace: {
            serverId: fixture.home.id, workspaceId: 'shared-checkout', machineId: 'm1', rootPath: '/repo' } }, [], 'workingTree'); return null; }
        await fixture.render(<Host />);
        const current = () => { if (!suggestion) throw new Error('Hook not mounted'); return suggestion; };
        await act(async () => { await current().generate(); });
        const oldKey = current().contextKey;
        const oldRead = current().generate();
        await flushHookEffects({ cycles: 5 });
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
        const newAccount = await restoreServerAccountForTest({ serverUrl: fixture.home.serverUrl, accountId: 'bob',
            credentials: { token: createAccountTokenForTests('bob', { currentAccount: true }) }, request: async (url, init) => {
            const handled = await fixture.suggestionRequest(url, init);
            if (handled) return handled;
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            return Response.json({}, { status: 404 });
        } });
        try {
            fixture.storage.getState().applySettingsLocal(settings);
            await flushHookEffects({ cycles: 10 });
            expect(current().contextKey).not.toBe(oldKey);
            await act(async () => {
                const result = await current().generate();
                expect(result, JSON.stringify(result)).toMatchObject({ ok: false, runId: 'new', outcome: 'pending' });
            });
            held.resolve(output('old'));
            expect(await oldRead).toMatchObject({ ok: false, errorCode: 'SCM_COMMIT_MESSAGE_SCOPE_RETIRED' });
            expect(await oldRead).not.toHaveProperty('message');
            await act(async () => { expect(await current().generate()).toMatchObject({ ok: true, message: 'new Account message' }); });
            expect(starts).toBe(2);
        } finally { await newAccount.dispose(); }
    });
    it('observes and cancels the admitted native Run rather than starting another suggestion', async () => {
        let terminal = false;
        fixture = await createSuggestionFixture({ start: () => pendingStart('retained'), rpc: request => {
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) return { ok: true };
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return { run: {
                runId: 'retained', callId: 'call', sidechainId: 'sidechain', intent: 'scm_commit_message',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'no_tools', retentionPolicy: 'ephemeral',
                runClass: 'bounded', ioMode: 'request_response', status: terminal ? 'succeeded' : 'running', startedAtMs: 1,
                ...(terminal ? { finishedAtMs: 2 } : {}),
            }, ...(terminal ? { latestToolResult: { message: 'feat: retained suggestion' } } : {}) };
            return undefined;
        } });
        fixture.storage.getState().applySettingsLocal({ scmCommitMessageGeneratorEnabled: true, scmCommitMessageGeneratorRunnerV1: { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'default' } } });
        const { useScmCommitMessageSuggestion } = await import('./useScmCommitMessageSuggestion');
        let suggestion: ReturnType<typeof useScmCommitMessageSuggestion> | null = null;
        function Host() {
            suggestion = useScmCommitMessageSuggestion({ kind: 'workspace', workspace: { serverId: fixture.home.id,
                workspaceId: 'checkout', machineId: 'm1', rootPath: '/repo' } }, ['src/file.ts'], 'workingTree');
            return null;
        }
        await fixture.render(<Host />);
        const current = () => { if (!suggestion) throw new Error('Hook not mounted'); return suggestion; };
        let first: Awaited<ReturnType<ReturnType<typeof current>['generate']>>;
        await act(async () => { first = await current().generate(); });
        expect(first!, JSON.stringify(first!)).toMatchObject({ ok: false, runId: 'retained', outcome: 'pending' });
        await act(async () => { await current().cancel(); });
        terminal = true;
        let second: Awaited<ReturnType<ReturnType<typeof current>['generate']>>;
        await act(async () => { second = await current().generate(); });
        expect(second!).toMatchObject({ ok: true, message: 'feat: retained suggestion' });
        expect(fixture.startRequests).toHaveLength(1);
        expect(fixture.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: { runId: 'retained' } }),
        ]);
        expect(fixture.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: { runId: 'retained', includeStructured: true } }),
        ]);
    });
});
