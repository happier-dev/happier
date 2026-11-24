import axios from 'axios';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { afterEach, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
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
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => vi.restoreAllMocks());

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
const workflowContext: ActionExecutorContext = {
  surface: 'agent',
  authority: 'account_automation',
  actionRequestId: 'backup-invocation',
  executionRunWorkflowRunId: 'workflow-run',
  executionRunTargetMachineId: 'workflow-publisher',
  actionCaller: {
    kind: 'workflowRun',
    runId: 'workflow-run',
    authorization: {
      principal: { kind: 'host' },
      admittedPermissionCeiling: 'read-only',
    },
  },
};

function harness(
  actionId: CaseId,
  options: Readonly<{ waived: boolean }> = { waived: true },
) {
  const { input, result } = cases[actionId];
  const environment = createDeploymentEnvironmentHeaderV1({
    id: input.environmentId,
    serverId: input.serverId,
    controllerMachineId: input.machineId,
  });
  vi.spyOn(axios, 'request').mockImplementation(async ({ url }) => {
    if (
      new URL(String(url)).pathname ===
      `/v1/deployments/environments/${input.environmentId}`
    ) {
      return { status: 200, data: { ok: true, environment, targetLinks: [] } };
    }
    if (new URL(String(url)).pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
      return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    }
    throw new Error(`Unexpected Home request ${String(url)}`);
  });
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/v1/account/encryption')
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path !== `/v1/machines/${input.machineId}`)
      throw new Error(`Unexpected Home read ${url}`);
    return {
      status: 200,
      data: {
        machine: {
          id: input.machineId,
          kind: 'persistent',
          active: true,
          installationId: input.installationId,
          storageMode: 'plain',
          revokedAt: null,
          replacedByMachineId: null,
          installationPublicKey: Buffer.from(
            ed25519.getPublicKey(new Uint8Array(32).fill(19)),
          ).toString('base64'),
          access: {
            custodian: {
              accountId: 'deployment-account',
              displayName: 'Owner',
            },
            role: 'manage',
            resourceMode: 'plain',
            accessState: 'ready',
          },
        },
      },
    };
  });
  const homeCalls: string[] = [];
  const send = vi.spyOn(axios, 'post').mockImplementation(async (url, data) => {
    const path = new URL(url).pathname;
    homeCalls.push(path);
    const request =
      ExternalActionExecutionAuthorizationRequestV1Schema.parse(data);
    const workflowActionOrigin = {
      runId: 'workflow-run',
      requestId: 'backup-invocation',
    };
    const canonicalInput = { ...input, serverId: 'srv_deployment_home' };
    if (path.endsWith('/execution-authorization')) {
      expect(request).toMatchObject({
        machineId: 'workflow-publisher',
        workflowActionOrigin,
        envelope: { target, input: canonicalInput },
      });
      return {
        status: 200,
        data: ExternalActionExecutionAuthorizationV1Schema.parse({
          v: 1,
          token: 'home-proof',
          binding: {
            accountId: 'deployment-account',
            custodianAccountId: 'deployment-account',
            authentication: { kind: 'terminal', tokenEpoch: 7 },
            accountEncryptionMode: 'plain',
            serverIdentityId: 'srv_deployment_home',
            machineId: input.machineId,
            installationId: input.installationId,
            actionId,
            requestId: request.envelope.requestId,
            target,
            workflowActionOrigin,
            environmentId: input.environmentId,
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
        }),
      };
    }
    expect(path).toBe(`/v1/actions/${actionId}`);
    expect(request).toMatchObject({
      machineId: input.machineId,
      executionAuthorization: {
        token: 'home-proof',
        binding: { workflowActionOrigin },
      },
    });
    return {
      status: 200,
      data: ExternalActionResponseEnvelopeV1Schema.parse({
        v: 1,
        actionId,
        requestId: 'backup-invocation',
        execution: { ok: true, result },
      }),
    };
  });
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
        scope: { kind: 'environment', environmentId: input.environmentId },
        surface: 'agent',
        mode: 'waived',
      })
    : normalizeActionsSettingsV1({});
  const executor = createCliActionExecutorFromCredentials({
    credentials: { token: publisherToken, encryption: null },
    serverId: input.serverId,
    serverIdentityId: 'srv_deployment_home',
    serverApiUrl: 'https://deployment-home.test',
    machineId: 'workflow-publisher',
    pluginActionExecutionOwner: 'current_process',
    // The installed owners, as the daemon approval-decide executor composes them.
    deploymentBackupAction: installedBackup,
    deploymentRestore: installedRestore,
    runActionOperation: installedOperation,
    externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(
      new Uint8Array(32).fill(9),
    ).secretKey,
    externalActionMachineInstallationId: 'workflow-installation',
    machineActionDirectTargetTransport: {
      machineId: 'workflow-publisher',
      invoke: async () => {
        throw new Error('The Workflow publisher is not the backup target');
      },
    },
    actionsSettingsProvider: { getActionsSettings: () => settings },
  });
  return {
    executor,
    input,
    result,
    send,
    homeCalls,
    installedBackup,
    installedRestore,
    installedOperation,
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
