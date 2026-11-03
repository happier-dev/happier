import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createFilesystemEffectAdmission } from './fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerFileSystemHandlers } from './fileSystem/registerFileSystemHandlers';

const heldHome = 'home';
const physicalHost = { custodianAccountId: 'account', machineId: 'machine', installationId: 'installation' } as const;

/** Verified Home receipt/currentness is the transport boundary in these owner
 * tests. Filesystem admission, path policy, Actions and native effects stay real.
 * Explicit requester contexts are never replaced with this owner fixture.
 */
export function createFilesystemOwnerRpcContext(): RpcHandlerContext {
  return {
    signal: new AbortController().signal,
    callerAuthority: 'present_user',
    machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({
      actorAccountId: physicalHost.custodianAccountId, ...physicalHost, role: 'manage', encryptionMode: 'plain',
    }),
    verifyMachineAdmissionCurrent: async () => true,
  };
}

/** Compose the existing handler fixtures with the same admission dependency as
 * an installed receiver, rather than disabling the fail-closed registrar.
 */
export function registerOwnerFilesystemRpcHandlers(
  registrar: RpcHandlerRegistrar,
  workingDirectory: string,
  options?: Parameters<typeof registerFileSystemHandlers>[2],
): ReturnType<typeof registerFileSystemHandlers> {
  const ownerContext = createFilesystemOwnerRpcContext();
  const boundary: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      registrar.registerHandler(method, (input, context) => handler(input,
        context?.machineAdmission || context?.verifyMachineAdmissionCurrent || context?.callerAuthority || context?.callerInputAuthorization
          || context?.sessionActionOrigin || context?.requesterSessionBootstrap || context?.localActionContext
          ? context : { ...context, ...ownerContext, signal: context?.signal ?? ownerContext.signal }));
    },
  };
  return registerFileSystemHandlers(boundary, workingDirectory, {
    ...options,
    effectAdmission: options?.effectAdmission ?? createFilesystemEffectAdmission({
      resolveHomeServerIdentityId: async () => heldHome,
      resolveHostIdentity: async () => physicalHost,
    }),
  });
}
