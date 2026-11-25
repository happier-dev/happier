import '../../../../ui/sources/dev/vitestSetup';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1, SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/sessionWorkspaceReturnActionIdsV1';
import { SessionWorkspaceReturnPreviewV1Schema } from '@happier-dev/protocol/actions/specs/session/projectFilesReturn';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import type { ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { scanWorkspaceManifest } from '@/scm/workspace/workspaceExportPackaging/scanWorkspaceManifest';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createPlainProjectAccountRefRow } from '@/workspaces/projectAccountRows.testkit';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import { buildDiffFileEntries } from '../../../../ui/sources/components/ui/code/model/diff/diffViewModel';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '../../../../ui/sources/dev/testkit/harness/syncSingletonLoader';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

vi.mock('../../../../ui/sources/modal', async () => (
  await import('../../../../ui/sources/dev/testkit/mocks/modal')
).createModalModuleMock({ confirmResult: true }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const {
  prepareSessionProjectFilesReturn, applySessionProjectFilesReturn, projectSessionProjectFilesReturnReviewState,
} = await import('../../../../ui/sources/sync/ops/sessionProjectFilesReturn');

it('brings an SSH Project copy back through the UI review and owner approval to the guest file', async () => {
  const holder = resolveSessionHolderExecutablePath();
  const helper = resolveProcessCustodySupportExecutable('linux');
  if (!holder || !helper) throw new Error('The Return journey requires the native holder and custody helper');
  for (const surface of ['ui', 'owner-api'] as const) {
    const sessions = new Map<string, ReturnType<typeof createSessionRecordFixture>>();
    const openTarget = async ({ lifetime }: { lifetime: AbortSignal }) => ({
      home: guestHome, holderPath: holder, helperPath: helper, lifetime,
      ensureWorkspaceRuntime: async () => ({ binaryPath: '/ssh-guest/happier' }),
      openChannel: (argv: readonly string[], signal: AbortSignal) => {
        if (argv[0] !== 'sh') {
          const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], signal });
          return Duplex.from({ readable: child.stdout, writable: child.stdin });
        }
        const input = new PassThrough();
        const output = new PassThrough();
        const channel = Duplex.from({ readable: output, writable: input });
        void runWorkspaceEffectWorker([], { input, output, signal, currentDirectory: () => guestHome })
          .then(() => output.end(), error => channel.destroy(error));
        return channel;
      },
    });
    let guestHome = '';
    const prepare = SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1;
    const apply = SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1;
    const h = await createHarness(prepare, surface === 'owner-api' ? 'ask' : 'default', false, 'srv_n2', undefined, false, false, {
      authentication: 'account', machineCustodianAccountId: 'account', machineRole: 'manage',
      additionalActionIds: [apply], workspaceReturn: { sessions, openTarget },
    });
    try {
      guestHome = join(h.directory, 'ssh-guest-home');
      const original = join(guestHome, 'repo');
      const copy = join(h.directory, 'controller-copy');
      await mkdir(original, { recursive: true });
      await mkdir(copy);
      await writeFile(join(original, 'tracked.txt'), 'guest baseline\n');
      runScmExecutable(copy, 'git', ['init', '-q']);
      await writeFile(join(copy, '.gitignore'), 'local-only.txt\n');
      await writeFile(join(copy, 'tracked.txt'), 'guest baseline\n');
      runScmExecutable(copy, 'git', ['add', '.gitignore', 'tracked.txt']);
      runScmExecutable(copy, 'git', ['-c', 'user.name=Return Fixture', '-c', 'user.email=return@example.test', 'commit', '-qm', 'base']);
      const baseline = await scanWorkspaceManifest({ workspaceRoot: original, safeFilterPolicy: { excludeAdministrativePaths: true } });
      await writeFile(join(copy, 'tracked.txt'), 'reviewed copy edit\n');
      await writeFile(join(copy, 'local-only.txt'), 'ignored controller file\n');
      const source: ManagedWorkspaceRefV2 = { v: 2, kind: 'managed', id: 'ssh-original', managedId: 'ssh-fixture',
        controller: { machineId: 'machine', installationId: h.installation.installationId }, rootPath: original, serverId: 'srv_n2', createdAtMs: 1 };
      const copyRef = { ...h.ref, id: 'return-copy', rootPath: copy };
      h.rows.push(createPlainProjectAccountRefRow(source), createPlainProjectAccountRefRow(copyRef));
      await h.refreshProjectRows();
      const sessionId = 'copied-session';
      sessions.set(sessionId, createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', dataEncryptionKey: null, share: null,
        metadata: JSON.stringify({ machineId: 'machine', path: copy, host: 'controller', sessionCreationCorrespondenceV1: {
          v: 1, sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: sessionId }),
          recipe: { execution: { machineId: 'machine', directory: { kind: 'path', path: copy } },
            organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
            connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
            agentSessionStartupInstructionsMarkerV1: null, checkout: null,
            projectFilesOrigin: { sourceWorkspace: workspaceAddressFromRefV2(source), targetWorkspace: {
              serverId: copyRef.serverId, machineId: copyRef.machineId, workspaceId: copyRef.id, rootPath: copyRef.rootPath,
            }, baseline },
          },
        } }),
      }));
      const target = { sessionId, machineId: 'machine' };
      const serverId = await homes.addHome({ name: 'Return Home', serverUrl: 'https://home.example.test',
        serverIdentityId: 'srv_n2', accountId: 'account', credentials: { token: h.humanToken }, currentAccount: true });
      const headers = { Authorization: 'Bearer ' + h.humanToken };
      for (const path of ['/v1/machines/machine', '/v1/machines']) {
        homes.answer(serverId, path, { select: async () => ({ body: (await axios.get('https://home.example.test' + path, { headers })).data }) });
      }
      for (const actionId of [prepare, apply]) for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
        homes.answer(serverId, path, { select: async input => {
          const result = await axios.post('https://home.example.test' + path, input, { headers });
          return { status: result.status, body: result.data };
        } });
      }
      const executeOwnerApproval = async (actionId: typeof prepare | typeof apply, input: unknown) => {
        const requested = await h.runOriginalCli(input, actionId);
        expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const decided = await h.decide('approve');
        expect(decided.ok ? 'approved' : [decided.errorCode, decided.failureCause?.phase]).toBe('approved');
        const execution = (await h.approval()).execution;
        if (!execution) throw new Error('The approved Return had no execution receipt');
        return execution;
      };
      let review;
      if (surface === 'owner-api') {
        const execution = await executeOwnerApproval(prepare, target);
        expect(execution).toMatchObject({ ok: true });
        if (!execution.ok) continue;
        review = SessionWorkspaceReturnPreviewV1Schema.parse(execution.result);
      } else {
        const prepared = await prepareSessionProjectFilesReturn(target, { serverId });
        expect.soft(prepared.ok ? 'prepared' : [prepared.errorCode, prepared.failureCause?.phase,
          typeof prepared.details?.reviewDigest === 'string']).toBe('prepared');
        if (!prepared.ok) continue;
        expect(projectSessionProjectFilesReturnReviewState(prepared)).toMatchObject({ kind: 'ready' });
        review = prepared.result;
      }
      const files = buildDiffFileEntries(review.paths.flatMap(path => path.files.map(file => ({
        filePath: file.path, unifiedDiff: file.evidence.unifiedDiff ?? '',
      }))));
      expect.soft(files.map(file => file.filePath)).toContain('tracked.txt');
      expect(files.map(file => file.filePath)).not.toContain('local-only.txt');
      expect(files.filter(file => file.filePath === '.git' || file.filePath.startsWith('.git/'))).toEqual([]);
      expect(files.find(file => file.filePath === 'tracked.txt')?.unifiedDiff).toContain('+reviewed copy edit');
      await expect(readFile(join(original, 'tracked.txt'), 'utf8')).resolves.toBe('guest baseline\n');
      const selection = { ...target, returnId: review.returnId, paths: ['tracked.txt'] };
      const applied = surface === 'owner-api' ? await executeOwnerApproval(apply, selection)
        : await applySessionProjectFilesReturn(selection, { serverId });
      expect(applied).toMatchObject({
        ok: true, result: { appliedPaths: ['tracked.txt'], conflicts: [] },
      });
      await expect(readFile(join(original, 'tracked.txt'), 'utf8')).resolves.toBe('reviewed copy edit\n');
      if (surface === 'ui') {
        const refused = await applySessionProjectFilesReturn({ ...selection, returnId: 'missing-review' }, { serverId });
        expect(refused).toMatchObject({ ok: false, errorCode: 'invalid_request',
          failureCause: { phase: 'workspace.return.apply', errorCode: 'invalid_request' } });
      }
    } finally {
      await homes.reset();
      await h.close();
      vi.restoreAllMocks();
      resetFilesystemApprovalSocketBoundary();
      withdrawActiveProjectAccountRowsSnapshot();
    }
  }
});
