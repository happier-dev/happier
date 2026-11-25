import axios from 'axios';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
  projectDeploymentNativeAdmissionV1,
  projectDeploymentReadAdmissionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import {
  normalizeActionsSettingsV1,
  setScopedActionApprovalPreference,
} from '@happier-dev/protocol/actions/actionSettings';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import {
  DeploymentBackupActionResultSchemasV1,
  DeploymentBackupRestoreResultV1Schema,
  type DeploymentBackupActionResultV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createActionExecutor, type ActionExecuteResult, type ActionExecutorContext } from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createActionAutomationHttpPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { encryptWithDataKey } from '@/api/encryption';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { assertDeploymentContentAuthorityForHost } from '@/deployments/deploymentDefinitionAdmission';

// The installation identity file is the receiving Machine's filesystem boundary; the replay preparer reads it.
const installationFile = vi.hoisted(() => ({ identity: null as null | { installationId: string; publicKey: string; privateKey: string } }));
vi.mock('@/daemon/identity/store', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/identity/store')>();
  return { ...actual, readInstallationIdentityIfExistsSync: (...args: Parameters<typeof actual.readInstallationIdentityIfExistsSync>) =>
    installationFile.identity ? { ...actual.readInstallationIdentityIfExistsSync(...args), ...installationFile.identity }
      : actual.readInstallationIdentityIfExistsSync(...args) };
});

let currentnessChannel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
beforeEach(async () => { currentnessChannel = await createRequesterCurrentnessSocketHarness(); });
afterEach(async () => { await currentnessChannel.close(); vi.restoreAllMocks(); });

// The daemon approval-decide executor carries the installed backup owner. A replayed
// Workflow Ask has no signed root of its own: it must spend the Workflow's Home admission
// (L11, 2026-11-24: the installed owner ran it with the daemon bearer and Home refused).
const publisherToken = `header.${Buffer.from(
  JSON.stringify({
    sub: 'deployment-account',
    tokenEpoch: 7,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
  }),
).toString('base64url')}.signature`;
const target = { kind: 'machine' as const, machineId: 'backup-target' };
const targetFields = {
  serverId: 'deployment-home',
  machineId: target.machineId,
  installationId: 'backup-installation',
  environmentId: 'source-env',
  targetLinkId: 'source-link',
  deploymentId: 'deployment',
  expectedRevision: 8,
};
const manifest = {
  schemaVersion: 1,
  environmentId: 'source-env',
  sourceId: '["dump","database"]',
  kind: 'dump',
  configRevision: 1,
  repositoryId: 'b'.repeat(64),
  snapshot: {
    snapshotId: 'a'.repeat(64),
    treeId: 'c'.repeat(64),
    hostname: 'happier-env-source',
    time: '2026-11-24T06:55:02.128183776Z',
    paths: ['/database.dump'],
    tags: ['happier'],
  },
  totalBytesProcessed: 1716,
  totalFilesProcessed: 1,
  producerChecksumSha256: 'd'.repeat(64),
};
const cases = {
  'deployments.backups.run': {
    input: { ...targetFields, configRevision: 1 },
    result: {
      kind: 'verified',
      operationId: 'backup-operation',
      manifests: [manifest],
    },
  },
  'deployments.backups.restore': {
    input: {
      ...targetFields,
      mode: 'prepare',
      source: {
        kind: 'repository',
        backupOperationId: 'capture',
        snapshotId: 'a'.repeat(64),
      },
      destination: { kind: 'database', service: 'database', database: 'app' },
    },
    result: { kind: 'prepared', operationId: 'restore-prepare', evidence: {} },
  },
} as const;
type CaseId = keyof typeof cases;
// A Move replaces the runtime Link from its accepted Run (L16, 2026-11-25).
const linkCase = {
  input: {
    // The accepted Move definition names its Home by identity, as the live Run did.
    serverId: 'srv_deployment_home', environmentId: targetFields.environmentId, expectedRevision: targetFields.expectedRevision,
    requestKey: 'workflow-move:link', targetId: 'own-server', role: 'runtime', targetKind: 'ownServer',
    replacesLinkId: targetFields.targetLinkId, expectedTargetLinkRevision: 2,
    machines: [{ machineId: targetFields.machineId, installationId: targetFields.installationId }],
  },
  result: { ok: true, environmentId: targetFields.environmentId, revision: targetFields.expectedRevision + 1,
    targetLinkId: 'replacement-link', targetLinkRevision: 1 },
} as const;
const harnessCases = { ...cases, 'deployments.targets.link': linkCase };
type HarnessCaseId = keyof typeof harnessCases;
const workflowContext: ActionExecutorContext = {
  surface: 'agent',
  authority: 'account_automation',
  actionRequestId: 'workflow-run/backup-leaf/0',
  executionRunWorkflowRunId: 'workflow-run',
  executionRunTargetMachineId: 'workflow-publisher',
  actionCaller: {
    kind: 'workflowRun',
    runId: 'workflow-run',
    authenticatedStarterV1: { requestRef: 'workflow-start', requester: { accountId: 'deployment-account', serverId: 'srv_deployment_home' } },
    authorization: {
      principal: { kind: 'host' },
      admittedPermissionCeiling: 'read-only',
    },
  },
};

function harness(
  actionId: HarnessCaseId,
  options: Readonly<{
    waived: boolean;
    mode?: 'plain' | 'e2ee';
    actualReceiver?: boolean;
    productionReceiver?: boolean;
    receiptReadFailure?: 'unreachable' | 'missing-key';
    approveAtCoordinator?: boolean;
    relayExecution?: ActionExecuteResult;
    differentReceipt?: (receipt: ApprovalRequestV2) => ApprovalRequestV2 | null;
    /** The receiver opens its own Ask; the test replays that stored root at the receiver. */
    linkReplay?: boolean;
  }> = { waived: true },
) {
  const { input, result } = harnessCases[actionId];
  const mode = options.mode ?? 'plain';
  const secret = new Uint8Array(32).fill(23);
  const credentials = { token: publisherToken, encryption: mode === 'e2ee'
    ? { type: 'legacy' as const, secret }
    : null };
  const publisherKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
  const receiverKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
  const authentication = { kind: 'terminal' as const, tokenEpoch: 7 };
  const accountId = 'deployment-account';
  const approvalId = 'coordinator-ask';
  let receipt: ApprovalRequestV2 | undefined;
  const receiptReads: string[] = [];
  const settingsContent = mode === 'e2ee' ? prepareAccountSettingsV2Content({ credentials, raw: {}, envelopeKind: 'encrypted' }) : null;
  const dataKey = createResourceDataKey({ credentials, mode });
  const receiverApproval = vi.fn(async () => ({ artifactId: 'receiver-ask' }));
  const receiverBackup = vi.fn(async () => cases['deployments.backups.run'].result);
  const receiverRestore = vi.fn(async () => cases['deployments.backups.restore'].result);
  let receiverAutomationReads = 0;
  const deploymentBackupAction = async <Id extends keyof typeof DeploymentBackupActionResultSchemasV1>(id: Id) => {
    if (id !== 'deployments.backups.run') throw new Error('Unexpected backup effect');
    return DeploymentBackupActionResultSchemasV1[id].parse(await receiverBackup()) as DeploymentBackupActionResultV1<Id>;
  };
  const deploymentRestore = async () => DeploymentBackupRestoreResultV1Schema.parse(await receiverRestore());
  const receiver = options.productionReceiver ? createCliActionExecutorFromCredentials({
    credentials,
    serverId: targetFields.serverId,
    serverIdentityId: 'srv_deployment_home',
    serverApiUrl: 'https://deployment-home.test',
    machineId: targetFields.machineId,
    pluginActionExecutionOwner: 'current_process',
    deploymentBackupAction,
    deploymentRestore,
    runActionOperation: createHostActionOperationRuntime({
      serverId: targetFields.serverId,
      machineId: targetFields.machineId,
      resolveAccountId: async () => accountId,
    }).runActionOperation,
  }) : createActionExecutor({
    ...createUnavailableActionTransportDeps(),
    approvalsCreate: receiverApproval,
    actionAutomations: createActionAutomationHttpPortV1({ accountId, async request(path) {
      expect(path).toBe(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1);
      receiverAutomationReads++;
      // The coordinator can reach Home's index. This installation cannot.
      if (options.approveAtCoordinator) throw Object.assign(new Error('Home unreachable'), { code: 'server_unreachable' });
      return ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] });
    } }),
    resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async (id, args) => {
      if (id !== 'deployments.environments.get') throw new Error('Unexpected scope read');
      return { ok: true, environment: { ...environment, serverId: args.serverId }, targetLinks: [] };
    }),
    deploymentBackupAction,
    deploymentRestore,
  });
  let receivedExecution: unknown;
  const environment = createDeploymentEnvironmentHeaderV1({
    id: targetFields.environmentId,
    serverId: targetFields.serverId,
    controllerMachineId: targetFields.machineId,
  });
  vi.spyOn(axios, 'request').mockImplementation(async ({ url }) => {
    if (
      new URL(String(url)).pathname ===
      `/v1/deployments/environments/${targetFields.environmentId}`
    ) {
      return { status: 200, data: { ok: true, environment, targetLinks: [] } };
    }
    if (new URL(String(url)).pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
      return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    }
    // The receiving daemon's Machine inventory read; this Account has no managed Machines.
    if (options.linkReplay && new URL(String(url)).pathname === '/v1/machines/managed/actions/list') return { status: 200, data: { machines: [] } };
    throw new Error(`Unexpected Home request ${String(url)}`);
  });
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/v1/account/encryption')
      return { status: 200, data: { mode, updatedAt: 1 } };
    if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: settingsContent, version: 0 } };
    if (path.startsWith('/v1/artifacts/')) {
      receiptReads.push(path);
      if (path !== `/v1/artifacts/${approvalId}` || !receipt) return { status: 404, data: {} };
      if (options.receiptReadFailure === 'unreachable') {
        throw Object.assign(new Error('Home unreachable'), { code: 'ECONNREFUSED' });
      }
      const stored = options.differentReceipt ? options.differentReceipt(receipt) : receipt;
      if (!stored) return { status: 404, data: {} };
      const key = await dataKey;
      const encode = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, key.dataKey));
      return { status: 200, data: {
        id: approvalId, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
        dataEncryptionKey: options.receiptReadFailure === 'missing-key' ? encodeBase64(new Uint8Array(32))
          : key.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encode(buildApprovalRequestArtifactHeaderV1(stored)),
        body: encode({ body: JSON.stringify(stored) }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      } };
    }
    if (path === '/v1/account/encryption/currentness')
      return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
    if (path !== `/v1/machines/${targetFields.machineId}`)
      throw new Error(`Unexpected Home read ${url}`);
    return {
      status: 200,
      data: {
        machine: {
          id: targetFields.machineId,
          kind: 'persistent',
          active: true,
          installationId: targetFields.installationId,
          storageMode: mode,
          ...(mode === 'e2ee' ? { metadata: createMachineContentCodec({
            encryptionMode: 'e2ee', encryptionKey: secret, encryptionVariant: 'legacy',
          }).encodeStored({
            host: 'target', platform: 'linux', happyCliVersion: '0.3.0',
            homeDir: '/fixture', happyHomeDir: '/fixture/.happier',
            installationPublicKey: encodeBase64(receiverKey.publicKey, 'base64url'),
          }) } : {}),
          revokedAt: null,
          replacedByMachineId: null,
          installationPublicKey: encodeBase64(receiverKey.publicKey),
          access: {
            custodian: {
              accountId: 'deployment-account',
              displayName: 'Owner',
            },
            role: 'manage',
            resourceMode: mode,
            accessState: 'ready',
          },
        },
      },
    };
  });
  const homeCalls: string[] = [];
  const dispatchedRoots: unknown[] = [];
  let linkDelivery: Readonly<{ root: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>;
    envelope: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>['envelope'] }> | undefined;
  const send = vi.spyOn(axios, 'post').mockImplementation(async (url, data) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
    if (path === '/v3/automations/runs/workflow-storage') return { status: 404, data: { error: 'not_found' } };
    homeCalls.push(path);
    const request =
      ExternalActionExecutionAuthorizationRequestV1Schema.parse(data);
    const workflowActionOrigin = request.workflowActionOrigin ?? request.executionAuthorization?.binding.workflowActionOrigin;
    expect(workflowActionOrigin).toMatchObject({ runId: 'workflow-run', requestId: 'workflow-run/backup-leaf/0' });
    const canonicalInput = { ...input, serverId: 'srv_deployment_home' };
    if (path.endsWith('/execution-authorization')) {
      if (!workflowActionOrigin || !request.installationProof || !request.envelope.requestId) throw new Error('Missing Workflow installation proof');
      expect(verifyMachineInstallationProof({ publicKey: publisherKey.publicKey, proof: request.installationProof,
        payload: { version: 1, accountId, machineId: request.machineId, installationId: 'workflow-installation',
          externalActionOrigin: { homeId: 'srv_deployment_home', actionId, requestId: request.envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: workflowActionOrigin } } })).toBe(true);
      expect(request).toMatchObject({
        machineId: 'workflow-publisher',
        workflowActionOrigin,
        // The backup operands are canonicalized here; the Link owner normalizes its own intent.
        envelope: mode === 'plain' ? { v: 1, target, ...(actionId in cases ? { input: canonicalInput } : {}) } : { v: 2, target },
      });
      return { status: 200, data: JSON.parse(JSON.stringify(homeRoot(request))) };
    }
    expect(path).toBe(`/v1/actions/${actionId}`);
    // A Workflow proposal is minted by Home at dispatch; a minted root is relayed as issued.
    const delivered = request.executionAuthorization ?? homeRoot(request);
    dispatchedRoots.push(request.executionAuthorization);
    if (actionId in cases) expect(request).toMatchObject({
      machineId: targetFields.machineId,
      executionAuthorization: {
        token: 'home-proof',
        binding: { workflowActionOrigin },
      },
    });
    if (options.linkReplay) linkDelivery = { root: delivered, envelope: request.envelope };
    return relay(request, delivered);
  });
  const homeRoot = (request: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>) => {
    const workflowActionOrigin = request.workflowActionOrigin ?? request.executionAuthorization?.binding.workflowActionOrigin;
    const canonicalInput = { ...input, serverId: 'srv_deployment_home' };
    return ExternalActionExecutionAuthorizationV1Schema.parse({
          v: 1,
          token: 'home-proof',
          binding: {
            accountId: 'deployment-account',
            custodianAccountId: 'deployment-account',
            authentication,
            accountEncryptionMode: mode,
            serverIdentityId: 'srv_deployment_home',
            machineId: targetFields.machineId,
            installationId: targetFields.installationId,
            actionId,
            requestId: request.envelope.requestId,
            target,
            workflowActionOrigin,
            ...(actionId === 'deployments.targets.link' ? { deploymentLinkAdmission: {
              environmentId: targetFields.environmentId, owner: environment.owner,
              replacement: { replacesLinkId: linkCase.input.replacesLinkId,
                expectedTargetLinkRevision: linkCase.input.expectedTargetLinkRevision,
                machines: linkCase.input.machines },
            } } : { environmentId: targetFields.environmentId }),
            deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(
              actionId,
              canonicalInput,
            ),
            deploymentReadAdmission: projectDeploymentReadAdmissionV1(
              actionId,
              canonicalInput,
            ),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(
              request.envelope,
            ),
          },
        });
  };
  const relay = async (request: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>,
    authorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>) => {
    const workflowActionOrigin = authorization.binding.workflowActionOrigin;
    if (options.actualReceiver || options.productionReceiver || options.linkReplay) {
      const receive = () => executeExternalAction({
        actionId,
        envelope: request.envelope,
        principal: { accountId, authentication, authority: 'account_automation', workflowActionOrigin },
        executionAuthorization: authorization,
        currentMachineId: target.machineId,
        currentAccountId: accountId,
        currentServerId: targetFields.serverId,
        currentServerHttpBaseUrl: 'https://deployment-home.test',
        currentInstallationId: targetFields.installationId,
        verifyExecutionAuthorization: async () => true,
        externalActionMachineRequestPrivateKey: receiverKey.secretKey,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
        executor: receiver,
        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({
          authorization: request.authorization, purpose: { kind: 'external_action' }, machineId: target.machineId,
          installationId: targetFields.installationId, installationPrivateKey: receiverKey.secretKey, serverId: targetFields.serverId,
          serverIdentityId: authorization.binding.serverIdentityId, serverHttpBaseUrl: 'https://deployment-home.test',
          ownCredentials: credentials, isCurrent: async () => true, createExecutor: () => receiver,
        }),
      });
      const [received, repeated] = await Promise.all([
        receive(),
        options.productionReceiver ? receive() : undefined,
      ]);
      if (repeated && received.kind === 'response' && received.response.v === 1 && received.response.execution.ok) {
        expect(repeated).toMatchObject({
          kind: 'response', response: { v: 1, execution: { ok: true, result } },
        });
      }
      if (received.kind !== 'response') {
        receivedExecution = received;
        return { status: 400, data: { error: received.errorCode, requestId: received.requestId } };
      }
      receivedExecution = request.envelope.v === 2 ? openExternalActionResponseV2({
        envelope: received.response, request: request.envelope, binding: authorization.binding,
        material: { type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) },
      }) : received.response.v === 1 ? received.response.execution : null;
      return { status: 200, data: received.response };
    }
    return {
      status: 200,
      data: ExternalActionResponseEnvelopeV1Schema.parse({
        v: 1,
        actionId,
        requestId: 'workflow-run/backup-leaf/0',
        execution: options.relayExecution ?? { ok: true, result },
      }),
    };
  };
  const installedBackup = vi.fn(
    async () =>
      ({
        kind: 'verified',
        operationId: 'installed',
        manifests: [manifest],
      }) as never,
  );
  const installedRestore = vi.fn(
    async () =>
      ({ kind: 'prepared', operationId: 'installed', evidence: {} }) as never,
  );
  const installedOperation = vi.fn(
    async (request: {
      context: ActionExecutorContext;
      execute(context: ActionExecutorContext): Promise<unknown>;
    }) =>
      request.execute({
        ...request.context,
        operationAcceptance: {
          operationId: 'installed-operation',
          actionId,
          accept() {},
        },
      }) as never,
  );
  const settings = options.waived
    ? setScopedActionApprovalPreference({
        settings: normalizeActionsSettingsV1({}),
        actionId,
        scope: { kind: 'environment', environmentId: targetFields.environmentId },
        surface: 'agent',
        mode: 'waived',
      })
    : normalizeActionsSettingsV1({});
  const executorOptions = {
    credentials,
    serverId: targetFields.serverId,
    serverIdentityId: 'srv_deployment_home',
    serverApiUrl: 'https://deployment-home.test',
    machineId: 'workflow-publisher',
    pluginActionExecutionOwner: 'current_process' as const,
    // The installed owners, as the daemon approval-decide executor composes them.
    deploymentBackupAction: installedBackup,
    deploymentRestore: installedRestore,
    runActionOperation: installedOperation,
    externalActionMachineRequestPrivateKey: publisherKey.secretKey,
    externalActionMachineInstallationId: 'workflow-installation',
    machineActionDirectTargetTransport: {
      machineId: 'workflow-publisher',
      invoke: async () => {
        throw new Error('The Workflow publisher is not the backup target');
      },
    },
    actionsSettingsProvider: { getActionsSettings: () => settings },
  };
  const ctx = resolveSessionEncryptionContextFromCredentials(credentials);
  const transport = ctx ? { mode: 'e2ee' as const, ctx } : { mode: 'plain' as const, ctx: null };
  const executor = options.approveAtCoordinator
    ? createCliActionExecutorHarness({ ...executorOptions, ...transport, token: publisherToken, sessionId: '',
      serverHttpBaseUrl: executorOptions.serverApiUrl, runtimeActionMachineId: executorOptions.machineId,
    }, {
      approvalsCreate: async ({ request }) => {
        receipt = ApprovalRequestV2Schema.parse(request);
        return { artifactId: approvalId, request: receipt };
      },
      approvalsGet: async ({ artifactId }) => artifactId === approvalId ? structuredClone(receipt ?? null) : null,
      approvalsUpdate: async ({ artifactId, request, expectedStatus }) => {
        if (!receipt || artifactId !== approvalId) throw new Error('Expected the coordinator approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const settled = decideApprovalRequestTransition(receipt, next, { expectedStatus });
        if (settled.ok) receipt = structuredClone(next);
        return settled;
      },
      // The fixture Home owns which installed Workflow and request are live.
      isApprovalExecutionOriginCurrent: async () => true,
    }).executor : createCliActionExecutorFromCredentials(executorOptions);
  return {
    executor,
    input,
    result,
    receiptReads,
    async approve() {
      return executor.execute('approval.request.decide', { artifactId: approvalId, decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        runtimeAccountId: accountId, serverId: targetFields.serverId, serverIdentityId: 'srv_deployment_home',
      });
    },
    send,
    homeCalls,
    dispatchedRoots,
    installedBackup,
    installedRestore,
    installedOperation,
    receiverApproval,
    receiverBackup,
    receiverRestore,
    get receivedExecution() { return receivedExecution; },
    get receiverAutomationReads() { return receiverAutomationReads; },
    /**
     * The receiving daemon's durable Ask replay (L16): its Artifact retains only the wire root, the
     * production preparer reopens custody, and the production executor runs the Link content guard.
     */
    async replayLinkAtReceiver() {
      if (!linkDelivery) throw new Error('The Link leaf was not delivered');
      const stored = ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(linkDelivery.root)));
      const contentGuard: unknown[] = [];
      const linkReceiver = createCliActionExecutorFromCredentials({
        credentials, serverId: targetFields.serverId, serverIdentityId: 'srv_deployment_home',
        serverApiUrl: 'https://deployment-home.test', machineId: targetFields.machineId,
        pluginActionExecutionOwner: 'current_process',
        externalActionMachineRequestPrivateKey: receiverKey.secretKey, externalActionMachineInstallationId: targetFields.installationId,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}) },
        deploymentAction: async (id, _input, context) => {
          if (id === 'deployments.environments.get') return { ok: true, environment: { ...environment, serverId: targetFields.serverId }, targetLinks: [] } as never;
          await assertDeploymentContentAuthorityForHost(context);
          contentGuard.push(context.externalActionExecutionAuthorization?.binding.requestId);
          return linkCase.result as never;
        },
      });
      installationFile.identity = { installationId: targetFields.installationId,
        publicKey: encodeBase64(receiverKey.publicKey, 'base64url'), privateKey: encodeBase64(receiverKey.secretKey, 'base64url') };
      try {
        const prepare = createDaemonApprovalExecutionAuthorizationPreparer({ machineId: targetFields.machineId,
          serverId: targetFields.serverId, serverBaseUrl: 'https://deployment-home.test',
          daemonWorkSignal: new AbortController().signal,
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: targetFields.machineId, serverIdentityId: 'srv_deployment_home' }),
          prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({
            authorization: request.authorization, purpose: { kind: 'external_action' }, machineId: targetFields.machineId,
            installationId: targetFields.installationId, installationPrivateKey: receiverKey.secretKey, serverId: targetFields.serverId,
            serverIdentityId: 'srv_deployment_home', serverHttpBaseUrl: 'https://deployment-home.test',
            ownCredentials: credentials, isCurrent: async () => true, isCustodyCurrent: async () => true,
            createExecutor: () => linkReceiver,
          }),
        });
        const prepared = await prepare({ authorization: stored, originalActionEnvelope: linkDelivery.envelope });
        if (!prepared) return { execution: { ok: false as const, errorCode: 'approval_stale', error: 'approval_stale' }, contentGuard };
        try {
          const caller = workflowContext.actionCaller!;
          const execution = await linkReceiver.execute('deployments.targets.link', linkCase.input, {
            surface: 'agent', authority: 'account_automation', serverId: targetFields.serverId,
            serverIdentityId: 'srv_deployment_home', runtimeAccountId: accountId, actionRequestId: stored.binding.requestId,
            actionCaller: caller, externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: target,
            originalActionEnvelope: linkDelivery.envelope, bypassApprovals: true,
            approvedActionReplay: { artifactId: 'receiver-ask', origin: { surface: 'agent', caller, accountId } },
          });
          return { execution, contentGuard };
        } finally { await prepared.dispose?.(); }
      } finally { installationFile.identity = null; }
    },
  };
}

it.each(Object.keys(cases) as CaseId[])(
  'spends the Workflow Home admission for a replayed Workflow %s, not the installed owner',
  async (actionId) => {
    const run = harness(actionId);
    const execution = await run.executor.execute(
      actionId,
      run.input,
      workflowContext,
    );
    expect(
      execution,
      JSON.stringify({ execution, homeCalls: run.homeCalls }),
    ).toMatchObject({ ok: true, result: run.result });
    expect(run.homeCalls).toEqual([
      expect.stringMatching(/\/execution-authorization$/u),
      `/v1/actions/${actionId}`,
    ]);
    expect(run.installedBackup).not.toHaveBeenCalled();
    expect(run.installedRestore).not.toHaveBeenCalled();
    expect(run.installedOperation).not.toHaveBeenCalled();
  },
);

it.each(Object.keys(cases) as CaseId[])(
  'keeps a direct %s with its restored signed root on the installed owner',
  async (actionId) => {
    const run = harness(actionId);
    const requestId = 'direct-backup';
    const envelope = {
      v: 1 as const,
      requestId,
      target,
      input: { ...run.input, serverId: 'srv_deployment_home' },
    };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: 'direct-root',
      binding: {
        accountId: 'deployment-account',
        custodianAccountId: 'deployment-account',
        authentication: { kind: 'account', tokenEpoch: 7 },
        accountEncryptionMode: 'plain',
        serverIdentityId: 'srv_deployment_home',
        machineId: target.machineId,
        installationId: 'backup-installation',
        actionId,
        requestId,
        target,
        environmentId: run.input.environmentId,
        deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(
          actionId,
          envelope.input,
        ),
        requestEnvelopeDigest:
          computeExternalActionRequestEnvelopeDigestV1(envelope),
      },
    });
    const execution = await run.executor.execute(actionId, envelope.input, {
      surface: 'agent',
      authority: 'account_automation',
      actionRequestId: requestId,
      serverId: 'deployment-home',
      serverIdentityId: 'srv_deployment_home',
      runtimeAccountId: 'deployment-account',
      actionCaller: { kind: 'host' },
      externalActionExecutionAuthorization: root,
      externalActionTarget: target,
      originalActionEnvelope: envelope,
    });
    expect(execution.ok, JSON.stringify(execution)).toBe(true);
    expect(run.homeCalls).toEqual([]);
    expect(
      actionId === 'deployments.backups.run'
        ? run.installedBackup
        : run.installedRestore,
    ).toHaveBeenCalledTimes(1);
  },
);

it('seals the requester box on a Workflow runtime Link leaf for its receiver content custody (L16)', async () => {
  const actionId = 'deployments.targets.link';
  const run = harness(actionId);
  const execution = await run.executor.execute(actionId, run.input, workflowContext);
  // Without the box the receiver's Link content guard refuses
  // requester_account_projection_missing after approval replay.
  expect(run.homeCalls, JSON.stringify({ execution, roots: run.dispatchedRoots })).toEqual([
    expect.stringMatching(/\/execution-authorization$/u),
    `/v1/actions/${actionId}`,
  ]);
  expect(run.dispatchedRoots).toEqual([expect.objectContaining({
    token: 'home-proof', requesterAccountContext: expect.any(Object),
  })]);
  expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true, result: run.result });
});

// L16 (2026-11-25): the receiver opened the Ask, a person approved it once, and its replay ran the Link
// with no requester Account custody (requester_account_projection_missing).
it('replays an approved Workflow Link at its receiver with requester custody on a required-E2EE Account (L16)', async () => {
  const actionId = 'deployments.targets.link';
  const run = harness(actionId, { waived: false, mode: 'e2ee', linkReplay: true });
  const opened = await run.executor.execute(actionId, run.input, workflowContext);
  const ask = { kind: 'approval_request_created', artifactId: 'receiver-ask', actionId };
  expect.soft(run.receivedExecution, JSON.stringify({ opened, calls: run.homeCalls })).toMatchObject({ ok: true, result: ask });
  expect.soft(opened).toMatchObject({ ok: true, result: ask });
  // The person's single approval replays the stored root at the receiver; its Link content guard must pass.
  const replayed = await run.replayLinkAtReceiver();
  expect(replayed.execution, JSON.stringify(replayed.execution)).toMatchObject({ ok: true, result: run.result });
  expect(replayed.contentGuard).toEqual(['workflow-run/backup-leaf/0']);
});

it('refuses a cross-Account Workflow Link leaf before dispatch instead of sending it without custody', async () => {
  const actionId = 'deployments.targets.link';
  const run = harness(actionId, { waived: false, linkReplay: true });
  const memberRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'member-run-root', binding: {
    accountId: 'member-account', custodianAccountId: 'deployment-account', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain', serverIdentityId: 'srv_deployment_home', machineId: 'workflow-publisher',
    installationId: 'workflow-installation', actionId: 'workflow.run.start', requestId: 'member-run-start',
    target: { kind: 'machine', machineId: 'workflow-publisher' }, requestEnvelopeDigest: 'a'.repeat(43) } });
  const caller = workflowContext.actionCaller!;
  if (caller.kind !== 'workflowRun') throw new Error('Expected the Workflow caller');
  const execution = await run.executor.execute(actionId, run.input, { ...workflowContext,
    actionCaller: { ...caller, authenticatedStarterV1: { requestRef: 'member-start',
      requester: { accountId: 'member-account', serverId: 'srv_deployment_home' } },
      authorization: { ...caller.authorization, externalActionExecutionAuthorization: memberRoot } } });
  expect(execution, JSON.stringify({ execution, calls: run.homeCalls })).toMatchObject({ ok: false, errorCode: 'requester_credential_disclosure_required' });
  expect(run.homeCalls.filter(path => path.startsWith('/v1/actions/'))).toEqual([]);
});

it('does not run or mint an unapproved Workflow backup step', async () => {
  const run = harness('deployments.backups.run', { waived: false });
  const execution = await run.executor.execute(
    'deployments.backups.run',
    run.input,
    workflowContext,
  );
  expect(execution).not.toMatchObject({ ok: true, result: run.result });
  expect(
    run.homeCalls.filter(
      (path) =>
        path.endsWith('/execution-authorization') ||
        path.startsWith('/v1/actions/'),
    ),
  ).toEqual([]);
  expect(run.installedBackup).not.toHaveBeenCalled();
});

it.each((Object.keys(cases) as CaseId[]).flatMap(actionId =>
  (['plain', 'e2ee'] as const).map(mode => [actionId, mode] as const)))(
  'returns the exact receiver Ask for %s (%s)',
  async (actionId, mode) => {
    const run = harness(actionId, { waived: true, mode, actualReceiver: true });
    const execution = await run.executor.execute(actionId, run.input, workflowContext);
    const ask = { kind: 'approval_request_created', artifactId: 'receiver-ask', actionId };
    expect(run.receivedExecution, JSON.stringify({ execution, calls: run.homeCalls }))
      .toMatchObject({ ok: true, result: ask });
    expect(run.receiverApproval).toHaveBeenCalledTimes(1);
    expect(run.receiverBackup).not.toHaveBeenCalled();
    expect(run.receiverRestore).not.toHaveBeenCalled();
    expect(execution).toMatchObject({ ok: true, result: ask });
  },
);

it.each((Object.keys(cases) as CaseId[]).flatMap(actionId =>
  (['plain', 'e2ee'] as const).map(mode => [actionId, mode] as const)))(
  'runs %s once with the coordinator approval (%s)',
  async (actionId, mode) => {
    const run = harness(actionId, { waived: false, mode, actualReceiver: true, approveAtCoordinator: true });
    const opened = await run.executor.execute(actionId, run.input, workflowContext);
    expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId, artifactId: 'coordinator-ask' } });
    expect(run.homeCalls).toEqual([]);
    const settled = await run.approve();
    expect(run.receivedExecution, JSON.stringify({ settled, calls: run.homeCalls }))
      .toMatchObject({ ok: true, result: run.result });
    expect(settled).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(run.receiverApproval).not.toHaveBeenCalled();
    expect(run.receiptReads).toEqual(['/v1/artifacts/coordinator-ask']);
    expect(run.receiverAutomationReads).toBe(0);
    expect(actionId === 'deployments.backups.run' ? run.receiverBackup : run.receiverRestore).toHaveBeenCalledTimes(1);
  },
);

it('executes the approved backup once through the production receiver when delivery repeats', async () => {
  const actionId = 'deployments.backups.run';
  const run = harness(actionId, { waived: false, productionReceiver: true, approveAtCoordinator: true });
  const opened = await run.executor.execute(actionId, run.input, workflowContext);
  expect(opened).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  const settled = await run.approve();
  expect(run.receivedExecution, JSON.stringify(settled)).toMatchObject({ ok: true, result: run.result });
  expect(settled).toMatchObject({ ok: true, result: { status: 'executed' } });
  expect(run.receiverBackup).toHaveBeenCalledTimes(1);
});

it.each([
  ['unreachable', 'project_requester_home_unavailable'],
  ['missing-key', 'artifact_encryption_material_unavailable'],
] as const)('preserves the typed receipt-read failure when %s', async (receiptReadFailure, errorCode) => {
  const actionId = 'deployments.backups.run';
  const run = harness(actionId, { waived: false, mode: 'e2ee', actualReceiver: true, approveAtCoordinator: true,
    receiptReadFailure });
  const opened = await run.executor.execute(actionId, run.input, workflowContext);
  expect(opened).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  const settled = await run.approve();
  const failure = { ok: false, errorCode, effectAttempted: false };
  expect(run.receivedExecution, JSON.stringify(settled)).toMatchObject(failure);
  expect(settled).toMatchObject({ ok: true, result: { status: 'failed', execution: failure } });
  expect(run.receiverBackup).not.toHaveBeenCalled();
});

it.each([
  ['missing', () => null],
  ['unclaimed', (receipt: ApprovalRequestV2) => ({ ...receipt, status: 'approved' })],
  ['other action', (receipt: ApprovalRequestV2) => ({
    ...receipt, actionId: 'deployments.backups.restore',
    actionArgs: cases['deployments.backups.restore'].input,
    executionOriginV1: { ...receipt.executionOriginV1, actionId: 'deployments.backups.restore' },
  })],
  ['other Environment', (receipt: ApprovalRequestV2) => ({
    ...receipt, actionArgs: { ...cases['deployments.backups.run'].input, environmentId: 'unreviewed-environment' },
  })],
  ['other Machine', (receipt: ApprovalRequestV2) => ({
    ...receipt, actionArgs: { ...cases['deployments.backups.run'].input, machineId: 'unreviewed-machine' },
  })],
  ['other installation', (receipt: ApprovalRequestV2) => ({
    ...receipt, actionArgs: { ...cases['deployments.backups.run'].input, installationId: 'unreviewed-installation' },
  })],
  ['other Workflow request', (receipt: ApprovalRequestV2) => ({
    ...receipt, executionOriginV1: { ...receipt.executionOriginV1, requestId: 'workflow-run/another-leaf/0' },
  })],
  ['other Account', (receipt: ApprovalRequestV2) => {
    const origin = receipt.executionOriginV1;
    const caller = origin.caller;
    if (caller.kind !== 'workflowRun' || !caller.authenticatedStarterV1) throw new Error('Expected an authenticated Workflow starter');
    const accountId = 'another-account';
    return { ...receipt, executionOriginV1: { ...origin, accountId, caller: { ...caller,
      authenticatedStarterV1: { ...caller.authenticatedStarterV1,
        requester: { ...caller.authenticatedStarterV1.requester, accountId } },
    } } };
  }],
] as const)('refuses a coordinator receipt for %s before effect', async (_name, change) => {
  const actionId = 'deployments.backups.run';
  const run = harness(actionId, { waived: false, mode: 'e2ee', actualReceiver: true, approveAtCoordinator: true,
    differentReceipt: receipt => {
      const changed = change(receipt);
      return changed === null ? null : ApprovalRequestV2Schema.parse(changed);
    },
  });
  const opened = await run.executor.execute(actionId, run.input, workflowContext);
  expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  const settled = await run.approve();
  expect(run.receivedExecution, JSON.stringify(settled)).toMatchObject({
    ok: false, errorCode: 'approval_stale', effectAttempted: false,
  });
  expect(settled).toMatchObject({ ok: true, result: { status: 'failed',
    execution: { ok: false, errorCode: 'approval_stale', effectAttempted: false },
  } });
  expect(run.receiverApproval).not.toHaveBeenCalled();
  expect(run.receiverBackup).not.toHaveBeenCalled();
  expect(run.receiverRestore).not.toHaveBeenCalled();
});

it('preserves a typed relay refusal and rejects a malformed backup result', async () => {
  const actionId = 'deployments.backups.run';
  const refusal = { ok: false, errorCode: 'deployment_access_denied', error: 'deployment_access_denied', effectAttempted: false } as const;
  const denied = harness(actionId, { waived: true, relayExecution: refusal });
  expect(await denied.executor.execute(actionId, denied.input, workflowContext)).toMatchObject(refusal);

  const malformed = harness(actionId, { waived: true, relayExecution: { ok: true, result: { kind: 'verified' } } });
  expect(await malformed.executor.execute(actionId, malformed.input, workflowContext)).toMatchObject({
    ok: false, errorCode: 'invalid_action_output',
  });
});
