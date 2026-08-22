import {
  COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
  ComposerContentHandleV1Schema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

type ComposerMediaStageReleaseResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string }>;

type ComposerMediaStageCapabilityResponse = Readonly<{
  success: true;
  available: true;
  capability: typeof COMPOSER_MEDIA_CONTENT_CAPABILITY_V1;
}>;

function readReleaseHandle(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'handle')) return null;
  const handle = ComposerContentHandleV1Schema.safeParse(record.handle);
  return handle.success ? handle.data : null;
}

/**
 * The transfer-stage owner alone releases completed Composer media. The caller
 * supplies the public opaque claim; target and contribution bindings are read
 * from that claim and verified by the store.
 */
export function registerComposerMediaStageLifecycleRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{ store: ComposerMediaStageStore }>,
): void {
  rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1,
    async (raw: unknown): Promise<ComposerMediaStageCapabilityResponse> => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 0) {
        throw new TypeError('Invalid Composer media capability request');
      }
      return {
        success: true,
        available: true,
        capability: COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
      };
    },
  );

  rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE,
    async (raw: unknown): Promise<ComposerMediaStageReleaseResponse> => {
      const handle = readReleaseHandle(raw);
      if (!handle) return { success: false, error: 'Invalid Composer media release request' };

      try {
        const released = await deps.store.release({
          handle,
          executionTarget: handle.executionTarget,
          owner: handle.owner,
        });
        if (released.status === 'released') return { success: true };
        if (released.reason === 'notFound' || released.reason === 'expired') return { success: true };
        return { success: false, error: 'Composer media stage is unavailable' };
      } catch {
        return { success: false, error: 'Composer media stage is unavailable' };
      }
    },
  );
}
