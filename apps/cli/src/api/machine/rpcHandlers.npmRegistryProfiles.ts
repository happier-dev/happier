import {
  DaemonNpmRegistryProfileMutationRequestV1Schema,
  DaemonNpmRegistryProfileMutationResponseV1Schema,
  DaemonNpmRegistryProfilesGetRequestV1Schema,
  DaemonNpmRegistryProfilesGetResponseV1Schema,
  RPC_METHODS,
} from '@happier-dev/protocol/rpc';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';

export type NpmRegistryProfileRpcService = Pick<
  ReturnType<typeof createNpmRegistryProfileService>,
  'snapshot' | 'mutate'
>;

const INVALID_REQUEST = Object.freeze({
  status: 'error' as const,
  code: 'invalid_request' as const,
  retryable: false,
});

const UNAVAILABLE = Object.freeze({
  status: 'error' as const,
  code: 'unavailable' as const,
  retryable: true,
});

export function registerMachineNpmRegistryProfileRpcHandlers(input: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  machineId: string;
  service: NpmRegistryProfileRpcService;
}>): void {
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET,
    async (raw) => {
      const parsed = DaemonNpmRegistryProfilesGetRequestV1Schema.safeParse(raw);
      if (!parsed.success) return INVALID_REQUEST;
      if (parsed.data.machineId !== input.machineId) {
        return { status: 'error' as const, code: 'unavailable' as const, retryable: false };
      }
      try {
        return DaemonNpmRegistryProfilesGetResponseV1Schema.parse({
          status: 'success',
          snapshot: await input.service.snapshot(),
        });
      } catch {
        return UNAVAILABLE;
      }
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE,
    async (raw) => {
      const parsed = DaemonNpmRegistryProfileMutationRequestV1Schema.safeParse(raw);
      if (!parsed.success) return INVALID_REQUEST;
      if (parsed.data.machineId !== input.machineId) {
        return { status: 'error' as const, code: 'unavailable' as const, retryable: false };
      }
      try {
        return DaemonNpmRegistryProfileMutationResponseV1Schema.parse(
          await input.service.mutate(parsed.data),
        );
      } catch {
        return UNAVAILABLE;
      }
    },
  );
}
