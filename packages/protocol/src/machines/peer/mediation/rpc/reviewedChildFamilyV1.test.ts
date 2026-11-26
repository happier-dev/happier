import { describe, expect, it } from 'vitest';
import {
  createHostReviewedChildPortV1,
  readHostAdmittedReviewedChildV1,
} from '../../../../actions/executor/deploymentRoleChild.js';
import type { ActionExecutorContext } from '../../../../actions/executor/types.js';
import {
  ExternalActionExecutionAuthorizationV1Schema,
  type ReviewedActionChildHttpProofV1,
} from '../../../../actions/externalActionApi.js';
import { projectDeploymentNativeAdmissionV1 } from '../../../../deployments/deploymentCandidatePublicationV1.js';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '../../../managed/actionIdsV1.js';
import { readOriginalActionEnvelopeMachineRpcKindV1 } from '../../../../rpc/socket.js';
import { RPC_METHODS } from '../../../../rpc/methods.js';
import {
  isBackupReceiverSetupChildOperandV1,
  readReviewedMachineRpcChildFamilyV1,
} from './reviewedChildFamilyV1.js';
import { computeActionInputApprovalDigestV1 } from '../../../../actions/decisionAuthority.js';
import {
  SESSION_PROJECT_FILES_OPEN_CHILDREN_V1,
  buildSessionProjectFilesSourceOpenInputV1,
  isSessionProjectFilesSourceOpenChildInputV1,
} from '../../../../sessions/creation/sessionProjectFilesOpenV1.js';
import { isReviewedChildRecipientPurposeV1 } from '../../../../sessions/creation/sessionRequesterBootstrapV1.js';
import { SessionSpawnNewInputV2Schema } from '../../../../sessions/creation/sessionSpawnNewInputV2.js';

const homeId = 'srv_backup_home';
const rootInput = {
  serverId: homeId,
  environmentId: 'environment',
  expectedRevision: 3,
  intent: 'test' as const,
  destinationSetup: {
    kind: 'anotherMachine' as const,
    machineId: 'receiver',
    expectedInstallationId: 'receiver-installation',
    receiverInputs: {},
  },
  configuration: {
    configRevision: 1,
    destinationRef: { pluginId: 'happier.backup.local', localId: 'open' },
    occurrenceId: 'destination',
    config: { path: '/private/repository' },
    credentialBindings: [],
    sources: [
      {
        kind: 'dump' as const,
        sourceId: 'database',
        service: 'postgres',
        consistency: 'logical' as const,
      },
    ],
    ownership: { environmentId: 'environment', prefix: 'owner-prefix' },
    retention: { kind: 'keepEverything' as const },
  },
};
const target = { kind: 'machine' as const, machineId: 'source' };
const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
  v: 1,
  token: 'home-root',
  binding: {
    serverIdentityId: homeId,
    accountId: 'person',
    custodianAccountId: 'person',
    authentication: { kind: 'account', tokenEpoch: 1 },
    machineId: 'source',
    installationId: 'source-installation',
    actionId: 'deployments.backups.configure',
    requestId: 'backup-request',
    requestEnvelopeDigest: 'A'.repeat(43),
    target,
    environmentId: 'environment',
    deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(
      'deployments.backups.configure',
      rootInput,
    ),
  },
});

/** The reviewed child exactly as the host issuer admits it under the Backup configure root. */
async function issueReceiverChild(
  machineId: string,
  child: {
    action: string;
    role: string;
  } = BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan,
) {
  const context: ActionExecutorContext = {
    runtimeAccountId: 'person',
    externalActionExecutionAuthorization: authorization,
    externalActionTarget: target,
  };
  let issued: (ReviewedActionChildHttpProofV1 & { input: unknown }) | null =
    null;
  const plan = {
    children: Object.values(BACKUP_RECEIVER_SETUP_CHILDREN_V1).map(
      (declared) => ({
        ...declared,
        scopeInput: { homeId, machineId: 'receiver' },
      }),
    ),
  };
  const port = createHostReviewedChildPortV1({
    actionId: 'deployments.backups.configure',
    input: rootInput,
    context,
    plan,
    policies: plan.children.map((declared) => ({
      action: declared.action,
      role: declared.role,
      surface: 'cli' as const,
    })),
    reviewAdmitted: true,
    execute: async (_input, childContext) => {
      issued = readHostAdmittedReviewedChildV1(childContext);
      return { ok: true, result: null };
    },
  });
  const result = await port.invoke({
    action: child.action as 'machines.setup.plan',
    role: child.role,
    input: { homeId, machineId },
  });
  return {
    result,
    issued: issued as
      | (ReviewedActionChildHttpProofV1 & { input: unknown })
      | null,
  };
}

function grammar(
  machineId: string,
  reviewedChild: ReviewedActionChildHttpProofV1 | undefined,
  params: unknown,
  effectActionId = 'machines.setup.plan',
) {
  return readOriginalActionEnvelopeMachineRpcKindV1({
    machineId,
    method: effectActionId,
    envelope: { v: 1, requestId: 'backup-request', target, input: rootInput },
    execution: {
      v: 1,
      authorization,
      effectActionId,
      target,
      installationId: 'source-installation',
      machineSignature: 'fixture',
      ...(reviewedChild ? { reviewedChild } : {}),
    },
    params,
  });
}

describe('cross-Machine reviewed child owner', () => {
  it('admits the Backup receiver Setup child only on the receiver its root review named', async () => {
    const { result, issued } = await issueReceiverChild('receiver');
    expect(result).toEqual({ ok: true, result: null });
    if (!issued)
      throw new Error(
        'Expected the issuer to admit the reviewed receiver Plan',
      );
    const { input: params, ...reviewedChild } =
      issued as ReviewedActionChildHttpProofV1 & { input: unknown };
    expect(reviewedChild).toMatchObject({
      actionId: 'machines.setup.plan',
      role: 'backup.receiver.plan',
    });
    const family = (
      machineId: string,
      child: ReviewedActionChildHttpProofV1 | undefined = reviewedChild,
    ) =>
      readReviewedMachineRpcChildFamilyV1({
        binding: authorization.binding,
        effectActionId: 'machines.setup.plan',
        method: RPC_METHODS.MACHINE_SETUP_PLAN,
        target: { machineId, installationId: 'source-installation' },
        reviewedChild: child,
      });
    expect(family('receiver')).toBe('backup_receiver_setup');
    expect(
      isBackupReceiverSetupChildOperandV1({
        binding: authorization.binding,
        reviewedChild,
        machineId: 'receiver',
        params,
      }),
    ).toBe(true);
    // Home's forwarder grammar consumes the same owner and the same operand check.
    expect(grammar('receiver', reviewedChild, params)).toBe('child');
    expect(grammar('receiver', reviewedChild, 'opaque-e2ee-params')).toBe(
      'child',
    );

    // A Machine the root's review did not name is refused.
    expect(family('elsewhere')).toBeNull();
    expect(
      grammar('elsewhere', reviewedChild, {
        ...(params as object),
        machineId: 'elsewhere',
      }),
    ).toBeNull();
    expect(
      isBackupReceiverSetupChildOperandV1({
        binding: authorization.binding,
        reviewedChild,
        machineId: 'elsewhere',
        params: { ...(params as object), machineId: 'elsewhere' },
      }),
    ).toBe(false);
    // The issuer refuses to mint a child for an unnamed receiver at all.
    expect((await issueReceiverChild('elsewhere')).result).toMatchObject({
      ok: false,
      errorCode: 'credential_scope_denied',
    });
    // A changed operand, another role, or no reviewed child is not this family's child.
    expect(
      grammar('receiver', reviewedChild, {
        ...(params as object),
        sources: [],
      }),
    ).toBeNull();
    expect(
      family('receiver', {
        ...reviewedChild,
        role: 'session_spawn_setup_plan',
      }),
    ).toBeNull();
    expect(
      readReviewedMachineRpcChildFamilyV1({
        binding: authorization.binding,
        effectActionId: 'machines.setup.plan',
        method: RPC_METHODS.MACHINE_SETUP_PLAN,
        target: { machineId: 'receiver', installationId: 'source-installation' },
      }),
    ).toBeNull();
    // Another root never inherits the receiver its own review did not name.
    expect(
      readReviewedMachineRpcChildFamilyV1({
        binding: {
          ...authorization.binding,
          actionId: 'deployments.backups.run',
        },
        effectActionId: 'machines.setup.plan',
        method: RPC_METHODS.MACHINE_SETUP_PLAN,
        reviewedChild,
      }),
    ).toBeNull();
  });

  it('keeps the existing Move child family through the same owner', () => {
    const move = {
      ...authorization.binding,
      actionId: 'projects.service.relocate',
      deploymentNativeAdmission: undefined,
    };
    expect(
      readReviewedMachineRpcChildFamilyV1({
        binding: move,
        effectActionId: 'localServices.launcher.start',
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
      }),
    ).toBe('service_move');
    expect(
      readReviewedMachineRpcChildFamilyV1({
        binding: move,
        effectActionId: 'localServices.launcher.start',
        method: RPC_METHODS.MACHINE_SETUP_PLAN,
      }),
    ).toBeNull();
  });

  it('admits session_project_files_source only for the exact reviewed source-attach operand on the root source Machine', () => {
    const spawnTarget = { kind: 'machine' as const, machineId: 'controller' };
    const spawnRoot = SessionSpawnNewInputV2Schema.parse({
      executionTarget: { serverId: homeId, machineId: 'controller' },
      directory: { kind: 'path', path: '/boat/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      sessionPlacement: {
        kind: 'machine',
        target: { serverId: homeId, machineId: 'controller' },
        projectFilesSource: { target: { serverId: homeId, machineId: 'boat' }, directory: '/boat/project' },
        projectFiles: { kind: 'copy_once' },
      },
    });
    const sourceOpenInput = buildSessionProjectFilesSourceOpenInputV1(spawnRoot.sessionPlacement!)!;
    const reviewedChild: ReviewedActionChildHttpProofV1 = {
      actionId: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.action,
      role: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.role,
      inputDigest: computeActionInputApprovalDigestV1('projects.open', sourceOpenInput),
    };
    const spawnAuth = ExternalActionExecutionAuthorizationV1Schema.parse({
      ...authorization,
      binding: {
        ...authorization.binding,
        machineId: 'controller',
        installationId: 'controller-installation',
        actionId: 'session.spawn_new',
        target: spawnTarget,
        environmentId: undefined,
        deploymentNativeAdmission: undefined,
      },
    });

    expect(readReviewedMachineRpcChildFamilyV1({
      binding: spawnAuth.binding, effectActionId: 'projects.open', method: RPC_METHODS.PROJECTS_OPEN,
      target: { machineId: 'boat', installationId: 'boat-installation' }, reviewedChild,
    })).toBe('session_project_files_source');
    expect(isSessionProjectFilesSourceOpenChildInputV1({
      rootInput: spawnRoot, reviewedChild, machineId: 'boat', params: sourceOpenInput,
    })).toBe(true);
    expect(readOriginalActionEnvelopeMachineRpcKindV1({
      machineId: 'boat', method: RPC_METHODS.PROJECTS_OPEN,
      envelope: { v: 1, requestId: 'backup-request', target: spawnTarget, input: spawnRoot },
      execution: { v: 1, authorization: spawnAuth, effectActionId: 'projects.open', target: spawnTarget,
        installationId: 'controller-installation', machineSignature: 'fixture', reviewedChild },
      params: sourceOpenInput,
    })).toBe('child');
    expect(isReviewedChildRecipientPurposeV1(spawnAuth, {
      kind: 'machine_rpc', method: RPC_METHODS.PROJECTS_OPEN, params: sourceOpenInput,
      recipient: { machineId: 'boat', installationId: 'boat-installation' }, reviewedChild,
    })).toBe(true);

    // Negatives: wrong Machine, tampered folder, non-attach materialization, disallowed cloneSource, wrong role, missing child, wrong root.
    const wrongMachineInput = { ...sourceOpenInput, machineId: 'elsewhere' };
    expect(isSessionProjectFilesSourceOpenChildInputV1({
      rootInput: spawnRoot, reviewedChild: { ...reviewedChild, inputDigest: computeActionInputApprovalDigestV1('projects.open', wrongMachineInput) },
      machineId: 'elsewhere', params: wrongMachineInput,
    })).toBe(false);
    expect(readOriginalActionEnvelopeMachineRpcKindV1({
      machineId: 'boat', method: RPC_METHODS.PROJECTS_OPEN,
      envelope: { v: 1, requestId: 'backup-request', target: spawnTarget, input: spawnRoot },
      execution: { v: 1, authorization: spawnAuth, effectActionId: 'projects.open', target: spawnTarget,
        installationId: 'controller-installation', machineSignature: 'fixture', reviewedChild },
      params: { ...sourceOpenInput, source: { kind: 'folder', path: '/boat/other' } },
    })).toBeNull();
    expect(isReviewedChildRecipientPurposeV1(spawnAuth, {
      kind: 'machine_rpc', method: RPC_METHODS.PROJECTS_OPEN,
      params: { ...sourceOpenInput, materialization: { kind: 'clone', destinationParentPath: '/tmp', destinationDirectoryName: 'x' } },
      recipient: { machineId: 'boat', installationId: 'boat-installation' }, reviewedChild,
    })).toBe(false);
    const cloneSourceInput = { ...sourceOpenInput, cloneSource: true as const };
    expect(isSessionProjectFilesSourceOpenChildInputV1({
      rootInput: spawnRoot, reviewedChild: { ...reviewedChild, inputDigest: computeActionInputApprovalDigestV1('projects.open', cloneSourceInput) },
      machineId: 'boat', params: cloneSourceInput,
    })).toBe(false);
    expect(readReviewedMachineRpcChildFamilyV1({
      binding: spawnAuth.binding, effectActionId: 'projects.open', method: RPC_METHODS.PROJECTS_OPEN,
      target: { machineId: 'boat', installationId: 'boat-installation' },
      reviewedChild: { ...reviewedChild, role: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.target.role },
    })).toBeNull();
    expect(readReviewedMachineRpcChildFamilyV1({
      binding: spawnAuth.binding, effectActionId: 'projects.open', method: RPC_METHODS.PROJECTS_OPEN,
      target: { machineId: 'boat', installationId: 'boat-installation' },
    })).toBeNull();
    expect(readReviewedMachineRpcChildFamilyV1({
      binding: { ...spawnAuth.binding, actionId: 'projects.open' }, effectActionId: 'projects.open',
      method: RPC_METHODS.PROJECTS_OPEN, target: { machineId: 'boat', installationId: 'boat-installation' }, reviewedChild,
    })).toBeNull();

    // F2 (B23): fully-resolved git_clone (source + branch) admits NO source-attach child, even with cloneSource: true;
    // unresolved git_clone (missing branch) admits only cloneSource: true.
    const resolvedGitCloneRoot = SessionSpawnNewInputV2Schema.parse({
      ...spawnRoot,
      sessionPlacement: {
        ...spawnRoot.sessionPlacement!,
        projectFiles: { kind: "git_clone", source: { provider: { id: "github", kind: "github", displayName: "GitHub", baseUrl: "https://github.com" }, repository: { nameWithOwner: "owner/project", cloneUrl: "https://github.com/owner/project.git" }, protocol: "https" }, branch: "main" },
      },
    });
    const cloneSourceReviewedChild: ReviewedActionChildHttpProofV1 = {
      ...reviewedChild,
      inputDigest: computeActionInputApprovalDigestV1("projects.open", cloneSourceInput),
    };
    expect(isSessionProjectFilesSourceOpenChildInputV1({
      rootInput: resolvedGitCloneRoot, reviewedChild: cloneSourceReviewedChild, machineId: "boat", params: cloneSourceInput,
    })).toBe(false);
    expect(isSessionProjectFilesSourceOpenChildInputV1({
      rootInput: resolvedGitCloneRoot, reviewedChild, machineId: "boat", params: sourceOpenInput,
    })).toBe(false);
    const unresolvedGitCloneRoot = SessionSpawnNewInputV2Schema.parse({
      ...spawnRoot,
      sessionPlacement: {
        ...spawnRoot.sessionPlacement!,
        projectFiles: { kind: "git_clone", source: { provider: { id: "github", kind: "github", displayName: "GitHub", baseUrl: "https://github.com" }, repository: { nameWithOwner: "owner/project", cloneUrl: "https://github.com/owner/project.git" }, protocol: "https" } },
      },
    });
    expect(isSessionProjectFilesSourceOpenChildInputV1({
      rootInput: unresolvedGitCloneRoot, reviewedChild: cloneSourceReviewedChild, machineId: "boat", params: cloneSourceInput,
    })).toBe(true);
    expect(isSessionProjectFilesSourceOpenChildInputV1({
      rootInput: unresolvedGitCloneRoot, reviewedChild, machineId: "boat", params: sourceOpenInput,
    })).toBe(false);
  });

});
