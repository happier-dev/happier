import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
beforeAll(prepareSessionFilesViewTestkit);
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('shared commit suggestion Run custody', () => {
    it('does not disclose a held old-Account result or clear the new Account pending Run', async () => {
        const { createDeferred, flushHookEffects } = await import('@/dev/testkit');
        const held = createDeferred<unknown>();
        let starts = 0;
        const output = (runId: string) => ({ run: { runId, callId: 'call', sidechainId: 'sidechain', intent: 'scm_commit_message',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'no_tools', retentionPolicy: 'ephemeral',
            runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 },
            latestToolResult: { message: runId === 'old' ? 'private old Account message' : 'new Account message' } });
        fixture = await createSessionFilesViewFixture({ rpc: request => {
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
                'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { protocolVersion: 2,
                    features: { detachedScope: true, startAndWait: true } } },
            } };
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START) return { runId: ++starts === 1 ? 'old' : 'new', callId: 'call', sidechainId: 'sidechain' };
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_WAIT) return { ok: true, status: 'running', disposition: 'observation_timeout',
                runId: starts === 1 ? 'old' : 'new', timeoutMs: 12_000, observedAtMs: 13_000, deadlineAtMs: 13_000 };
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return (request.payload as { runId: string }).runId === 'old' ? held.promise : output('new');
            return undefined;
        } });
        const settings = { scmCommitMessageGeneratorEnabled: true, scmCommitMessageGeneratorBackendId: 'claude' };
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
        const newAccount = await restoreServerAccountForTest({ serverUrl: fixture.home.serverUrl, accountId: 'bob', request: async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            return Response.json({}, { status: 404 });
        } });
        try {
            fixture.storage.getState().applySettingsLocal(settings);
            await flushHookEffects({ cycles: 10 });
            expect(current().contextKey).not.toBe(oldKey);
            await act(async () => { expect(await current().generate()).toMatchObject({ ok: false, runId: 'new', outcome: 'pending' }); });
            held.resolve(output('old'));
            expect(await oldRead).toMatchObject({ ok: false, errorCode: 'SCM_COMMIT_MESSAGE_SCOPE_RETIRED' });
            expect(await oldRead).not.toHaveProperty('message');
            await act(async () => { expect(await current().generate()).toMatchObject({ ok: true, message: 'new Account message' }); });
            expect(starts).toBe(2);
        } finally { await newAccount.dispose(); }
    });
    it('observes and cancels the admitted native Run rather than starting another suggestion', async () => {
        let terminal = false;
        fixture = await createSessionFilesViewFixture({ rpc: request => {
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
                'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { protocolVersion: 2,
                    features: { detachedScope: true, startAndWait: true } } },
            } };
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START) return { runId: 'retained', callId: 'call', sidechainId: 'sidechain' };
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_WAIT) return { ok: true, status: 'running', disposition: 'observation_timeout',
                runId: 'retained', timeoutMs: 12_000, observedAtMs: 13_000, deadlineAtMs: 13_000 };
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) return { ok: true };
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return { run: {
                runId: 'retained', callId: 'call', sidechainId: 'sidechain', intent: 'scm_commit_message',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'no_tools', retentionPolicy: 'ephemeral',
                runClass: 'bounded', ioMode: 'request_response', status: terminal ? 'succeeded' : 'running', startedAtMs: 1,
                ...(terminal ? { finishedAtMs: 2 } : {}),
            }, ...(terminal ? { latestToolResult: { message: 'feat: retained suggestion' } } : {}) };
            return undefined;
        } });
        fixture.storage.getState().applySettingsLocal({ scmCommitMessageGeneratorEnabled: true, scmCommitMessageGeneratorBackendId: 'claude' });
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
        expect(first!).toMatchObject({ ok: false, runId: 'retained', outcome: 'pending' });
        await act(async () => { await current().cancel(); });
        terminal = true;
        let second: Awaited<ReturnType<ReturnType<typeof current>['generate']>>;
        await act(async () => { second = await current().generate(); });
        expect(second!).toMatchObject({ ok: true, message: 'feat: retained suggestion' });
        expect(fixture.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START)).toHaveLength(1);
        expect(fixture.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: { runId: 'retained' } }),
        ]);
        expect(fixture.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: { runId: 'retained', includeStructured: true } }),
        ]);
    });
});
