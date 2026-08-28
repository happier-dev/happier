import {
  COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
  ComposerContentHandleV1Schema,
  ComposerInstanceIdSchema,
  ComposerRefV1Schema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type {
  ComposerMediaStageClaimant,
  ComposerMediaStageStore,
} from '@/transfers/staging/composerMediaStageStore';

type ComposerMediaStageReleaseResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string }>;

type ComposerMediaStageCapabilityResponse = Readonly<{
  success: true;
  available: true;
  capability: typeof COMPOSER_MEDIA_CONTENT_CAPABILITY_V1;
}>;

function readReleaseRequest(value: unknown): Readonly<{
  handle: ReturnType<typeof ComposerContentHandleV1Schema.parse>;
  claimant?: ComposerMediaStageClaimant;
}> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (!keys.every((key) => key === 'handle' || key === 'claimant') || !Object.hasOwn(record, 'handle')) return null;
  const handle = ComposerContentHandleV1Schema.safeParse(record.handle);
  if (!handle.success) return null;
  if (record.claimant === undefined) return { handle: handle.data };
  if (!record.claimant || typeof record.claimant !== 'object' || Array.isArray(record.claimant)) return null;
  const claimantRecord = record.claimant as Readonly<Record<string, unknown>>;
  if (Object.keys(claimantRecord).length !== 2) return null;
  const composer = ComposerRefV1Schema.safeParse(claimantRecord.composer);
  const attachmentInstanceId = ComposerInstanceIdSchema.safeParse(claimantRecord.attachmentInstanceId);
  return composer.success && attachmentInstanceId.success
    ? { handle: handle.data, claimant: { composer: composer.data, attachmentInstanceId: attachmentInstanceId.data } }
    : null;
}

/**
 * The transfer-stage owner alone releases completed Composer media. The caller
 * supplies the public opaque handle and, once attached, the host-private exact
 * Composer claimant. Target, contribution, and custody bindings are verified
 * by the store.
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
      const request = readReleaseRequest(raw);
      if (!request) return { success: false, error: 'Invalid Composer media release request' };

      try {
        const released = await deps.store.release({
          handle: request.handle,
          executionTarget: request.handle.executionTarget,
          owner: request.handle.owner,
          ...(request.claimant ? { claimant: request.claimant } : {}),
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
