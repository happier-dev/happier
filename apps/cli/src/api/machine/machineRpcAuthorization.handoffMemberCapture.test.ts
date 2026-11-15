import { describe, expect, it } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncSourceWriterTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
  admitSameMachineWorkspaceSyncTargetPhase,
  authorizeMachineRpcRequest,
  type MachineRpcAdmissionBoundary,
} from './machineRpcAuthorization';
import { registerMachineWorkspaceSyncRpcHandlers } from './rpcHandlers.workspaceSync';

// A Can use member hands a Session to another person's Machine with a
// workspace copy (owner rulings 2026-10-31, 2026-11-14, 2026-11-15). Without
// the member's own capture, no signed writer-target phase reaches the host's
// native workspace owner.
const member = {
  actorAccountId: 'member',
  custodianAccountId: 'host',
  machineId: 'host-target',
  installationId: 'host-installation',
  role: 'use' as const,
  encryptionMode: 'plain' as const,
};
const policy = {
  v: 1 as const,
  selection: 'all_files' as const,
  extraIgnorePatterns: [],
  extraIncludePatterns: [],
};
const contentPolicy = {
  ...policy,
  policyDigest: computeWorkspaceSyncPolicyDigest(policy),
};
const root = ExternalActionExecutionAuthorizationV1Schema.parse({
  v: 1,
  token: 'fixture-handoff-root',
  binding: {
    accountId: 'member',
    authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain',
    custodianAccountId: 'member',
    serverIdentityId: 'home',
    machineId: 'member-source',
    installationId: 'member-source-installation',
    actionId: 'session.handoff',
    requestId: 'handoff-copy',
    requestEnvelopeDigest: 'A'.repeat(43),
    target: { kind: 'machine', machineId: 'member-source' },
    handoffAdmission: {
      sessionId: 'member-session',
      sourceMachineId: 'member-source',
      sourceInstallationId: 'member-source-installation',
      targetMachineId: member.machineId,
      targetInstallationId: member.installationId,
    },
  },
});
const routing = (phase: 'preflight' | 'prepare') =>
  WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({
    v: 1,
    sourceWriter: {
      machineId: 'member-source',
      installationId: 'member-source-installation',
    },
    source: {
      v: 1,
      phase: 'prepare',
      operationId: root.binding.requestId,
      accountServerId: 'home',
      sourceMachineId: 'member-source',
      sourceRootPath: '/member/workspace',
      sourceSessionId: 'member-session',
      sourceContext: {
        machineAdmission: {
          actorAccountId: 'member',
          custodianAccountId: 'member',
          machineId: 'member-source',
          installationId: 'member-source-installation',
          role: 'manage',
          encryptionMode: 'plain',
        },
        callerAuthority: 'present_user',
        workspaceWrites: 'allow',
      },
    },
    target: {
      v: 1,
      phase,
      operationId: root.binding.requestId,
      accountServerId: 'home',
      targetMachineId: member.machineId,
      targetRootPath: '/home/host/.ssh',
    },
  });
const preflight = {
  method: `${member.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
  params: {
    v: 1,
    operationId: root.binding.requestId,
    serverId: 'home',
    machineId: member.machineId,
    targetPath: '/home/host/.ssh',
  },
  callerAuthority: 'present_user' as const,
  machineAdmission: member,
  callerInputAuthorization: root,
  workspaceSyncSourceWriterTargetRouting: routing('preflight'),
};
const prepare = {
  ...preflight,
  method: `${member.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`,
  workspaceSyncSourceWriterTargetRouting: routing('prepare'),
  params: {
    v: 1,
    bootstrapOperationId: root.binding.requestId,
    owner: {
      kind: 'copy_once',
      operation: {
        v: 1,
        operationId: root.binding.requestId,
        controllerMachineId: 'member-source',
        alphaWorkspaceRefId: 'source-ref',
        betaWorkspaceRefId: 'target-ref',
        contentPolicy,
      },
    },
    targetWorkspaceRefId: 'target-ref',
    endpointRole: 'beta',
    policyDigest: contentPolicy.policyDigest,
    createIfMissing: true,
    targetBootstrap: 'materialize_from_source_workspace',
  },
};

describe('Can use handoff target effects', () => {
  it('refuse with the typed Manage cause, before any host-native effect, without a member capture', async () => {
    const hostEffects: string[] = [];
    // Current Home verification is the network boundary; ingress, route
    // binding and the production handler registration stay real.
    const boundary: MachineRpcAdmissionBoundary = {
      machineId: member.machineId,
      resolveInstallationId: () => member.installationId,
      resolveCustodianAccountId: async () => 'host',
      resolveHomeServerIdentityId: async () => 'home',
      verifyMachineAdmission: async () => true,
      resolvePrivateWorkspaceSyncTargetExecution: () => ({
        kind: 'no_private_capture',
      }),
    };
    const rpc = new RpcHandlerManager({
      scopePrefix: member.machineId,
      localMachineId: member.machineId,
      encryptionMode: 'plain',
      logger: () => {},
      authorizeRequest: (incoming) =>
        authorizeMachineRpcRequest(incoming, boundary),
    });
    const unexpected = async (): Promise<never> => {
      throw new Error('Unexpected service call');
    };
    registerMachineWorkspaceSyncRpcHandlers({
      rpcHandlerManager: rpc,
      service: {
        controller: {} as never,
        prepareBetween: unexpected,
        relationshipOwner: {
          setEnabled: unexpected,
          stop: unexpected,
          create: unexpected,
        },
        readFileAtTarget: unexpected,
        observeEntryAtTarget: unexpected,
        inspectRetiredState: unexpected,
        releaseBootstrapAtTarget: unexpected,
        preflightHandoffTargetReplacement: async () => {
          hostEffects.push('preflight');
          return { type: 'not_required' };
        },
        prepareBootstrapAtTarget: async () => {
          hostEffects.push('prepare');
          return {
            v: 1,
            bootstrapOperationId: root.binding.requestId,
            targetWorkspaceRefId: 'target-ref',
            state: 'ready',
            created: true,
            rootFingerprint: '0'.repeat(64),
            policyDigest: contentPolicy.policyDigest,
          };
        },
      },
    });
    const results = [
      await rpc.handleRequest(preflight),
      await rpc.handleRequest(prepare),
    ];
    expect({ results, hostEffects }).toMatchObject({
      hostEffects: [],
      results: [
        { errorCode: 'machine_manage_required' },
        { errorCode: 'machine_manage_required' },
      ],
    });
  });

  it('refuses a same-Machine Can use handoff copy in process without a capture and keeps Manage native', () => {
    const sameMachine = (role: 'use' | 'manage') => {
      const admission = { ...member, role };
      const sameRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root, binding: { ...root.binding,
        custodianAccountId: 'host', machineId: member.machineId, installationId: member.installationId,
        target: { kind: 'machine', machineId: member.machineId }, handoffAdmission: { sessionId: 'member-session',
          sourceMachineId: member.machineId, sourceInstallationId: member.installationId,
          targetMachineId: member.machineId, targetInstallationId: member.installationId } } });
      const base = routing('prepare');
      return admitSameMachineWorkspaceSyncTargetPhase({ callerInputAuthorization: sameRoot, request: prepare.params,
        resolvePrivateCapture: () => ({ kind: 'no_private_capture' }), routing: { ...base,
        sourceWriter: { machineId: member.machineId, installationId: member.installationId },
        source: { ...base.source, sourceMachineId: member.machineId,
          sourceContext: { ...base.source.sourceContext, machineAdmission: admission } } } });
    };
    expect(sameMachine('use')).toMatchObject({ ok: false, errorCode: 'machine_manage_required' });
    expect(sameMachine('manage')).toMatchObject({ ok: true, machineAdmission: { role: 'manage', actorAccountId: 'member' } });
  });
});
