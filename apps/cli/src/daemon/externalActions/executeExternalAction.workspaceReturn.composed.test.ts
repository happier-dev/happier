import '../../../../ui/sources/dev/vitestSetup';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { createManagedBootstrapSshCredential, readManagedBootstrapCredential } from '@happier-dev/cli-common/machines/managed';
import { buildMachineProvisionerPinnedSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
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
import { configuration } from '@/configuration';
import { createManagedMachineAcquisitionDriver } from '@/machines/managed/acquire';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { fixture as createNativeProvisionerFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { buildDiffFileEntries } from '../../../../ui/sources/components/ui/code/model/diff/diffViewModel';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '../../../../ui/sources/dev/testkit/harness/syncSingletonLoader';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

vi.mock('../../../../ui/sources/modal', async () => (
  await import('../../../../ui/sources/dev/testkit/mocks/modal')
).createModalModuleMock({ confirmResult: true }).module);

const ssh = vi.hoisted(() => ({ guestHome: '', target: 'guest@192.0.2.7' }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (command: string, args: readonly string[], options: Parameters<typeof actual.spawn>[2]) => {
    if (command !== 'ssh') return actual.spawn(command, args, options);
    const target = args.indexOf(ssh.target);
    if (target === -1) throw new Error('SSH targeted an unexpected fixture guest');
    // Replace the SSH process with the guest shell. The transport, holder and native filesystem helper stay real.
    return actual.spawn('sh', ['-c', args.slice(target + 1).join(' ')], {
      ...options, env: { ...process.env, ...options?.env, HOME: ssh.guestHome },
    });
  } };
});

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
  const artifact = async (path: string) => {
    const bytes = await readFile(path);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const artifacts = { holder: await artifact(holder), helper: await artifact(helper) };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const bootstrapPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  for (const surface of ['owner-api', 'ui'] as const) {
    const sessions = new Map<string, ReturnType<typeof createSessionRecordFixture>>();
    let targetAdmissions = 0;
    let openTarget: ReturnType<typeof createManagedMachineAcquisitionDriver>['openProjectWorkspaceTarget'];
    let acquisitionFailure: unknown;
    const prepare = SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1;
    const apply = SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1;
    const h = await createHarness(prepare, surface === 'owner-api' ? 'ask' : 'default', false, 'srv_n2', undefined, false, false, {
      authentication: 'account', machineCustodianAccountId: 'account', machineRole: 'manage',
      additionalActionIds: [apply], workspaceReturn: { sessions, openTarget: async request => {
        const target = await openTarget({ ...request, holder: { version: 'return-fixture', resolveArtifacts: async () => artifacts } }).catch(error => {
          acquisitionFailure = error;
          throw error;
        });
        if (!target.holderPath || !target.helperPath) throw new Error('The acquisition did not place the holder');
        return { ...target, holderPath: target.holderPath, helperPath: target.helperPath };
      } },
    });
    try {
      const guestHome = ssh.guestHome = join(h.directory, 'ssh-guest-home');
      const controller = { machineId: 'machine', installationId: h.installation.installationId };
      const provider = { pluginId: 'acme.compute', localId: 'vm' };
      const resourceId = 'return-bootstrap';
      const credentialRef = { kind: 'shared_resource', resourceId } as const;
      const value = createManagedBootstrapSshCredential({ bootstrapPrivateKey,
        randomBytes: size => new Uint8Array(size).fill(4) });
      const { guestHostPublicKey } = readManagedBootstrapCredential(value);
      if (!guestHostPublicKey) throw new Error('Missing fixture SSH pin');
      const native = createNativeProvisionerFixture({ bootstrapCredential: 'ssh', credentialPurposes: [], nativeRoleResults: {
        bootstrap: buildMachineProvisionerPinnedSshBootstrap({
          connection: { address: '192.0.2.7', user: 'guest', port: 22 }, guestHostPublicKey, credentialRef,
        }),
      } });
      const homeUrl = 'https://home.example.test';
      const credentials = { token: h.installedToken, encryption: null };
      const row = ManagedMachineV1Schema.parse({ id: 'ssh-fixture', homeId: 'srv_n2', custodianAccountId: 'account', controller,
        launch: { provider, schemaVersion: 1, name: 'SSH fixture', choices: {} },
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
        resource: { contributionRef: provider, schemaVersion: 1, value: {} }, bootstrapCredentialRef: credentialRef,
        enrollmentIdentity: { kind: 'existingUser', role: 'adopted' },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        workspaceAttachment: { os: 'linux', arch: process.arch, home: guestHome },
      });
      const fixtureGet = vi.mocked(axios.get).getMockImplementation();
      if (!fixtureGet) throw new Error('Home fixture transport is missing');
      vi.mocked(axios.get).mockImplementation(async (url, options) => {
        if (new URL(String(url)).pathname !== '/v1/account/saved-secrets/resources/materials') return fixtureGet(url, options);
        return { status: 200, data: { resources: [{ resourceId, encryptionMode: 'plain', recipientEnvelope: null,
          storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
            content: { v: 1, name: 'SSH fixture', kind: 'other', value } }),
          entry: { ref: formatSharedSavedSecretRefV1(resourceId), source: 'shared_resource', relationship: 'owner',
            name: 'SSH fixture', kind: 'other', ownerAccountId: 'account', revision: 1,
            materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        }] } };
      });
      const noConnectedAccount = async (): Promise<never> => { throw new Error('Unexpected connected account use'); };
      const managedProviderOperationAuthority = createManagedProviderOperationAuthority({ materializationBaseDir: configuration.happyHomeDir,
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
          store: { read: async () => ({ v: 1, bindings: [] }), update: noConnectedAccount, subscribe: () => ({ dispose() {} }) },
          selectTarget: noConnectedAccount, resolveTarget: noConnectedAccount, materializeAccount: noConnectedAccount,
          projectTargetAccounts: noConnectedAccount, assertTargetAccountMaterializable: noConnectedAccount,
        }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => { throw new Error('Unexpected request auth port'); },
        createRedactionLease: () => ({ add() {}, close() {} }),
      });
      ({ openProjectWorkspaceTarget: openTarget } = createManagedMachineAcquisitionDriver({
        token: credentials.token, credentials, serverUrl: homeUrl, homeId: row.homeId, controller, managedProviderOperationAuthority,
        runtimeRegistry: native.runtimeRegistry,
        readTargetCurrent: async (managedId, requester) => {
          targetAdmissions += 1;
          return managedId === row.id
            ? { machine: row, admitted: requester.requesterAccountId === row.custodianAccountId } : null;
        },
        homeTarget: resolveHomeTargetFromDescriptor({ authority: 'current_connection', descriptor: {
          v: 1, homeServerIdentityId: row.homeId, canonicalServerUrl: homeUrl, revision: 1, endpoints: [{ kind: 'https', url: homeUrl }],
        } }),
      }));
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
      await writeFile(join(copy, 'unselected.txt'), 'reviewed but unselected\n');
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
        expect(execution.ok ? 'prepared' : { code: execution.errorCode, phase: execution.failureCause?.phase,
          acquisition: acquisitionFailure instanceof Error ? { name: acquisitionFailure.name, code: 'code' in acquisitionFailure ? acquisitionFailure.code : undefined,
            location: acquisitionFailure.stack?.split('\n')[1]?.trim() } : undefined }).toBe('prepared');
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
      expect(files.map(file => file.filePath)).toContain('unselected.txt');
      const admissionsAtReview = targetAdmissions;
      const selection = { ...target, returnId: review.returnId, paths: ['tracked.txt'] };
      const applied = surface === 'owner-api' ? await executeOwnerApproval(apply, selection)
        : await applySessionProjectFilesReturn(selection, { serverId });
      expect(applied.ok ? 'applied' : { code: applied.errorCode, phase: applied.failureCause?.phase }).toBe('applied');
      expect(applied).toMatchObject({
        ok: true, result: { appliedPaths: ['tracked.txt'], conflicts: [] },
      });
      await expect(readFile(join(original, 'tracked.txt'), 'utf8')).resolves.toBe('reviewed copy edit\n');
      await expect(readFile(join(original, 'unselected.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(targetAdmissions).toBe(admissionsAtReview);
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
