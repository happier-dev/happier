import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import { ScmChangeDiscardResponseSchema } from '@happier-dev/protocol/scm';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { applyInverseEdits } from '@happier-dev/protocol/diff/hunks';
import { WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { prepareScmFileBytesExport } from '@/scm/actions/deliverScmFileAtRevision';
import { createTestGitRpcManager, createTestGitScmBackendRegistry } from '@/scm/rpc/__tests__/testRpcHarness';
import { commitGuardedFileReplace } from '@/rpc/handlers/fileSystem/commitGuardedFileReplace';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createCliActionDeps, type MachineActionDirectTargetTransport } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

describe('Session comparison discard Machine placement', () => {
  it('retains Session proof for existing raw SCM work evidence at the real receiver', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-proof-' });
    const sessionId = 'c111111111111111111111111';
    const machineId = 'proof-machine';
    const receiver = createTestGitRpcManager({ workingDirectory: fixture.rootPath });
    const request = { cwd: fixture.rootPath, workEvidence: { sessionId } };
    try {
      const transport = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async input => {
        expect(input.authorization).toEqual({ kind: 'session.write', sessionId });
        for (const authorization of [undefined, { kind: 'session.write' as const, sessionId: 'foreign-session' }]) {
          expect(await receiver.call(input.method, input.request, authorization))
            .toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
        }
        return await receiver.call(input.method, input.request, input.authorization);
      });
      const executor = createActionExecutor(createCliActionDeps({ token: 'proof-token', credentials: { token: 'proof-token', encryption: null },
        sessionId: '', mode: 'plain', ctx: null,
        machineActionDirectTargetTransport: { machineId, invoke: async (method, input) => await receiver.call(method, input) } }));
      const result = await executor.execute('scm.branch.list', request, { surface: 'rpc', authority: 'account_automation',
        externalActionTarget: { kind: 'machine', machineId }, rpcSessionAuthorization: { kind: 'session.write', sessionId } });
      expect(result).toMatchObject({ ok: true, result: { success: true } });
      expect(transport).toHaveBeenCalledTimes(1);
      // A public external actor is not private requester custody. The same
      // installed owner must refuse rather than substituting its credentials.
      expect(await executor.execute('scm.branch.list', request, { surface: 'rpc', authority: 'account_automation',
        externalActionTarget: { kind: 'machine', machineId }, rpcSessionAuthorization: { kind: 'session.write', sessionId },
        externalActionCredential: { accountId: 'external-requester', principalId: 'principal', credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 },
      })).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { await rm(fixture.rootPath, { recursive: true, force: true }); }
  });

  it.each(['small', 'withoutUndo', 'export', 'direct', 'unavailable', 'unknown'] as const)('uses the existing Machine for every discard and Undo export (%s)', async mode => {
    await withTempDir('happier-local-discard-home-', async home => {
      const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SCM_MAX_OUTPUT_BYTES']);
      // This fixture crosses the reply budget. Let its preparatory Git read
      // use that same budget instead of the smaller ordinary command default.
      environment.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'discard-test-home',
        HAPPIER_SCM_MAX_OUTPUT_BYTES: String(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES) });
      reloadConfiguration();
      const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-local-discard-' });
      const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
      const sessionId = 'c111111111111111111111111';
      const machineId = 'local-review-machine';
      let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
      try {
        await updateSettings(settings => ({ ...settings, machineIdByServerId: { 'discard-test-home': machineId } }));
        admitted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
          runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        // Each control character takes six JSON bytes on either side of the
        // inverse. Cross the containing reply's budget, not a tunnel frame's.
        const spanLength = Math.floor(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES / 12) + 1;
        const before = { small: 'original small\n', large: `${'\u0001'.repeat(spanLength)}\n` };
        const after = { small: 'changed small\n', large: `${'\u0002'.repeat(spanLength)}\n` };
        for (const key of ['small', 'large'] as const) await writeFile(join(fixture.rootPath, `${key}.txt`), before[key]);
        runScmExecutable(fixture.rootPath, 'git', ['add', '.']);
        runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'local discard base']);
        for (const key of ['small', 'large'] as const) await writeFile(join(fixture.rootPath, `${key}.txt`), after[key]);
        const registry = createTestGitScmBackendRegistry();
        const selection = await registry.selectBackend({ cwd: fixture.rootPath, workingDirectory: fixture.rootPath });
        if (!selection?.backend.diffFile) throw new Error('The real Git diff owner is unavailable');
        const entries = await Promise.all((mode === 'small' ? ['small'] as const : ['small', 'large'] as const).map(async key => {
          const path = `${key}.txt`;
          const diff = await selection.backend.diffFile({
            context: { cwd: fixture.rootPath, projectKey: fixture.rootPath, detection: selection.detection },
            request: { cwd: fixture.rootPath, path, area: 'both' },
          });
          expect(diff).toMatchObject({ success: true, diff: expect.any(String) });
          if (!diff.success || diff.diff === undefined) throw new Error('Expected an admitted real Git diff');
          return { path, kind: 'comparison' as const, against: { source: { kind: 'workingTree' as const } },
            changeKeys: buildReviewUnits(path, 'combined', diff.diff).map(unit => unit.key), includeUndo: mode !== 'withoutUndo' };
        }));
        // Authenticated Home HTTP is a genuine network boundary. Workspace,
        // plugin admission, preparation and both Action executors remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).endsWith('/v1/account/encryption/currentness')
          ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
          : { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', machineId,
            metadata: JSON.stringify({ path: fixture.rootPath }), share: null }) } }));
        const remote = createTestGitRpcManager({ machineId, workingDirectory: fixture.rootPath,
          prepareFileBytesExport: async input => {
            for (const key of ['small', 'large'] as const) expect(await readFile(join(fixture.rootPath, `${key}.txt`), 'utf8')).toBe(after[key]);
            return await prepareScmFileBytesExport({ ...input, lifecycle });
          } });
        // Do not mistake a fixture assertion for the runtime's deliberate
        // unknown-outcome response to a failed transport acknowledgement.
        let boundaryAssertionFailure: unknown;
        const transport = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
          try {
          expect(request).toMatchObject({ machineId, method: 'scm.change.discard', authorization: { kind: 'session.write', sessionId } });
          for (const key of ['small', 'large'] as const) expect(await readFile(join(fixture.rootPath, `${key}.txt`), 'utf8')).toBe(after[key]);
          if (mode === 'unavailable') throw markRpcRequestDisposition(new Error('Machine unavailable'), 'notSent');
          const envelope = TargetedActionRpcRequestV1Schema.parse(request.request);
          expect(envelope).toMatchObject({ defaultSessionId: sessionId,
            target: { kind: 'machine', machineId, project: { machineId, directory: fixture.rootPath } } });
          const scopedEntries = entries.map(entry => ({ ...entry, against: { ...entry.against, sessionId } }));
          const scopedRequest = { ...envelope, input: { cwd: fixture.rootPath, outcomeVersion: 1, entries: scopedEntries } };
          // These refusals exercise the actual registered encrypted receiver,
          // not a fake executor or an adapter-only call assertion.
          for (const authorization of [undefined, { kind: 'session.write' as const, sessionId: 'foreign-session' }]) {
            expect(await remote.call(request.method, scopedRequest, authorization))
              .toMatchObject({ success: false, errorCode: 'COMPARISON_UNAVAILABLE' });
            for (const key of ['small', 'large'] as const) expect(await readFile(join(fixture.rootPath, `${key}.txt`), 'utf8')).toBe(after[key]);
          }
          for (const namespace of ['comparison', 'source'] as const) {
            const conflictingEntries = entries.map(entry => ({ ...entry, against: { ...entry.against,
              sessionId: namespace === 'comparison' ? 'foreign-session' : sessionId,
              ...(namespace === 'source' ? { comparisonId: 'f'.repeat(64),
                source: { kind: 'turnCheckpoint' as const, sessionId: 'foreign-session', turnId: 'foreign-turn' } } : {}),
            } }));
            expect(await remote.call(request.method, { cwd: fixture.rootPath, outcomeVersion: 1, entries: conflictingEntries }, request.authorization))
              .toMatchObject({ success: false, errorCode: 'COMPARISON_UNAVAILABLE' });
            for (const key of ['small', 'large'] as const) expect(await readFile(join(fixture.rootPath, `${key}.txt`), 'utf8')).toBe(after[key]);
          }
          const response = await remote.call(request.method, request.request, request.authorization);
          if (mode === 'unknown') throw markRpcRequestDisposition(new Error('Acknowledgement lost'), 'outcomeUnknown');
          return response;
          } catch (error) {
            if (error instanceof Error && error.name === 'AssertionError') boundaryAssertionFailure = error;
            throw error;
          }
        });
        const token = 'discard-session-token';
        const directInvocation = vi.fn(async () => { throw new Error('The local adapter cannot synthesize Home authorization'); });
        const direct: MachineActionDirectTargetTransport = { machineId, invoke: directInvocation };
        const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
          serverId: configuration.activeServerId, serverHttpBaseUrl: configuration.serverUrl, sessionId,
          ...(mode === 'direct' ? { machineActionDirectTargetTransport: direct } : {}),
          mode: 'plain', ctx: null, scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] } }));
        const result = await executor.execute('scm.change.discard', { cwd: '/ignored-input-root', entries },
          { surface: 'rpc', authority: 'account_automation', serverId: configuration.activeServerId, defaultSessionId: sessionId });
        if (boundaryAssertionFailure) throw boundaryAssertionFailure;
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('SCM Action must produce its typed outcome');
        const response = ScmChangeDiscardResponseSchema.parse(result.result);
        if (mode === 'small' || mode === 'withoutUndo') {
          expect(response.success).toBe(true);
          expect(transport).toHaveBeenCalledTimes(1);
          if (mode === 'small') expect(response.entries![0]!.inverseEdits).toBeDefined();
          else expect(response.entries![0]!.inverseEdits).toBeUndefined();
          expect(await readFile(join(fixture.rootPath, 'small.txt'), 'utf8')).toBe(before.small);
          expect(await readFile(join(fixture.rootPath, 'large.txt'), 'utf8')).toBe(mode === 'small' ? after.large : before.large);
        } else {
          expect(transport).toHaveBeenCalledTimes(1);
          expect(directInvocation).not.toHaveBeenCalled();
          expect(response).toMatchObject(mode === 'export' || mode === 'direct' ? { success: true }
            : { success: false, errorCode: mode === 'unavailable' ? 'COMPARISON_UNAVAILABLE' : 'COMMAND_OUTCOME_UNKNOWN' });
          for (const key of ['small', 'large'] as const) expect(await readFile(join(fixture.rootPath, `${key}.txt`), 'utf8'))
            .toBe(mode === 'unavailable' ? after[key] : before[key]);
          if (mode === 'export' || mode === 'direct') expect(response.entries![1]!.previous).toHaveProperty('export');
        }
        if (response.success && mode !== 'withoutUndo') {
          for (const entry of response.entries!) {
            const path = join(fixture.rootPath, entry.path);
            let bytes: Buffer;
            if (entry.inverseEdits) {
              const undone = applyInverseEdits(await readFile(path, 'utf8'), entry.inverseEdits);
              expect(undone.ok).toBe(true);
              if (!undone.ok) throw new Error('Discard inverse must restore the selected content');
              bytes = Buffer.from(undone.text);
            } else {
              if (!entry.previous || !('export' in entry.previous)) throw new Error('Oversized Undo must retain its preimage export');
              const prepared = entry.previous.export;
              const downloaded = await lifecycle.requestPayloadFile({ transferId: prepared.transferId,
                endpointCandidates: prepared.endpointCandidates, destinationPath: join(fixture.rootPath, `undo-${entry.path}`),
                expectedSizeBytes: prepared.sizeBytes, expectedManifestHash: prepared.manifestHash });
              bytes = await readFile(downloaded.destinationPath);
              lifecycle.clearPublishedTransfer(prepared.transferId);
            }
            expect(await commitGuardedFileReplace({ destPath: path, expectation: entry.hashAfter, source: { kind: 'bytes', bytes } }))
              .toMatchObject({ success: true, hash: entry.hashBefore });
            const key = entry.path === 'small.txt' ? 'small' : 'large';
            expect((await readFile(path)).equals(Buffer.from(after[key]))).toBe(true);
          }
        }
      } finally {
        await lifecycle.stop();
        await admitted?.dispose();
        await rm(fixture.rootPath, { recursive: true, force: true });
        environment.restore(); reloadConfiguration();
      }
    });
  });
});
