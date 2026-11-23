import { describe, expect, it } from 'vitest';
import {
  ExternalActionExecutionAuthorizationV1Schema,
  projectDeploymentNativeAdmissionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentChildRoutingV1Schema } from '@happier-dev/protocol/deployments/deploymentChildRoutingV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import {
  createFilesystemEffectAdmission,
  createFilesystemEffectRpcRegistrar,
} from './filesystemEffectAdmission';

// A fleet join: the holder signed the deploy root; the receiving guest is the
// same person's other Machine and receives the image archive as a finite child.
const target = { kind: 'machine' as const, machineId: 'holder' };
const content = { contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 };
const domainInput = { serverId: 'home', environmentId: 'environment', domainId: 'domain', ...content, expectedRevision: 1,
    expectedDomainRevision: 1, requestKey: 'request', targetLinkId: 'runtime', expectedTargetLinkRevision: 1 };
const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, custodianAccountId: 'owner', serverIdentityId: 'home',
    machineId: 'holder', installationId: 'holder-installation', actionId: 'deployments.domains.add', requestId: 'request',
    target, requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain', environmentId: 'environment',
    deploymentChildRoot: true, deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.domains.add', domainInput),
} });
const routing = DeploymentChildRoutingV1Schema.parse({ v: 1, kind: 'member', phase: 'restore', actionId: 'deployments.deploy',
    machineId: 'guest', installationId: 'guest-installation', deploymentId: 'deployment', actionOperationId: 'operation',
    selectedDeploymentId: 'deployment', input: { serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime',
        expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'request', ...content } });

function guestContext(
  method: string,
  archiveChild: boolean,
): RpcHandlerContext {
  return {
    signal: new AbortController().signal,
    callerAuthority: 'account_automation',
    callerInputAuthorization: authorization,
    machineAdmission: {
      actorAccountId: 'owner',
      custodianAccountId: 'owner',
      machineId: 'guest',
      installationId: 'guest-installation',
      role: 'manage',
      encryptionMode: 'plain',
    },
    verifyMachineAdmissionCurrent: async () => true,
    ...(archiveChild
      ? {
          workspaceSyncSourceExecution: {
            method: `guest:${method}`,
            requestId: 'copy-request',
            externalActionExecution: {
              v: 1,
              authorization,
              target,
              installationId: 'holder-installation',
              machineSignature: 's'.repeat(86),
              effectActionId: 'daemon.filesystem.copy',
              deploymentChildExecution: {
                method: 'guest:' + RPC_METHODS.DAEMON_DEPLOYMENT_CHILD,
                requestId: 'request',
                paramsPresent: true,
                paramsDigest: 'd'.repeat(43),
                externalActionExecution: {
                  v: 1,
                  authorization,
                  target,
                  installationId: 'holder-installation',
                  machineSignature: 's'.repeat(86),
                  effectActionId: 'deployments.deploy',
                  deploymentChildRouting: routing,
                },
                archiveOrigin: {
                  environmentId: 'environment',
                  deploymentId: 'deployment',
                  holderMachineId: 'holder',
                  holderInstallationId: 'holder-installation',
                },
              },
            },
          },
        }
      : {}),
  } as RpcHandlerContext;
}

function register(method: string) {
  const handlers = new Map<string, RpcHandler<unknown, unknown>>();
  const reached: string[] = [];
  const registrar = createFilesystemEffectRpcRegistrar(
    {
      registerHandler: (name, handler) => {
        handlers.set(name, handler as RpcHandler<unknown, unknown>);
      },
    },
    createFilesystemEffectAdmission({
      resolveHomeServerIdentityId: async () => 'home',
      readAgentIsolation: () => ({ enabled: false }) as never,
    }),
  );
  registrar.registerHandler(method, async () => {
    reached.push(method);
    return { success: true };
  });
  return {
    invoke: (context: RpcHandlerContext) => handlers.get(method)!({}, context),
    reached,
  };
}

describe('filesystem effect RPC registrar', () => {
  it('leaves an admitted deployment archive copy on the receiving Machine to its Action admission', async () => {
    const copy = register(RPC_METHODS.DAEMON_FILESYSTEM_COPY);
    await expect(
      copy.invoke(guestContext(RPC_METHODS.DAEMON_FILESYSTEM_COPY, true)),
    ).resolves.toEqual({ success: true });
    expect(copy.reached).toEqual([RPC_METHODS.DAEMON_FILESYSTEM_COPY]);
  });

  it.each([
    [
      'a copy without the admitted archive child',
      RPC_METHODS.DAEMON_FILESYSTEM_COPY,
      false,
    ],
    [
      'a generic write carrying an archive child',
      RPC_METHODS.DAEMON_FILESYSTEM_WRITE_FILE,
      true,
    ],
  ] as const)(
    'still refuses %s whose requester is not this Machine’s',
    async (_name, method, archiveChild) => {
      const effect = register(method);
      await expect(
        effect.invoke(guestContext(method, archiveChild)),
      ).resolves.toMatchObject({
        success: false,
        errorCode: 'filesystem_identity_custody_unavailable',
        details: { reason: 'requester_identity_unavailable' },
      });
      expect(effect.reached).toEqual([]);
    },
  );
});
