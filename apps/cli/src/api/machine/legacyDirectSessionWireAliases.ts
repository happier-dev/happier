import {
  ExternalSessionLinkEnsureRequestSchema as DirectSessionLinkEnsureRequestSchema,
  ExternalSessionTakeoverPersistRequestSchema as DirectSessionTakeoverPersistRequestSchema,
  ExternalSessionTakeoverRequestSchema as DirectSessionTakeoverRequestSchema,
  type ExternalSessionLinkEnsureResponse as DirectSessionLinkEnsureResponse,
  type ExternalSessionTakeoverPersistResponse as DirectSessionTakeoverPersistResponse,
  type ExternalSessionTakeoverResponse as DirectSessionTakeoverResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { externalSessionsError as directSessionsError } from '@/session/actions/externalSessions';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { mapCanonicalExternalSessionResponseToLegacyDirectSession } from './legacyDirectSessionResponseCompatibility';

// Stable cli-v0.2.1@b1d15a8a9c241737d1ca9b167459901e6259173a with
// ui-web-v0.2.0@dc5203145dea46a1280286eb74d90f20d8b9e817, preview
// cli-v0.2.2-preview.1775586717.26498 /
// ui-web-v0.2.2-preview.1775585938.1@4913c1e533c872a0712ba1c25b3104fd470aacc2,
// and the inspected remote-dev@04b48d57cd9717cbf42170448bf15ff59a795fc4
// predecessor create external-session links through this unphased method and
// then recognize the Session only from a `directSessionV1` metadata envelope
// (`sync/domains/session/sessionStorageKind.ts` requires
// `metadata.directSessionV1.v === 1`, and
// `sync/domains/session/directSessions/readDirectSessionLink.ts` requires the
// same envelope keyed by `providerId`). The canonical link builder writes only
// the canonical `externalSessionV1` envelope and strips the released one, so
// dispatching this alias would answer `ok: true` with a Session those clients
// render as an empty persisted row: no transcript tail, no direct-session
// status, no takeover. Retain parsing only and fail closed before any Session
// row or metadata write. Remove this alias when those clients and rollback
// targets no longer send it.
export function registerLegacyDirectSessionLinkEnsureWireAlias(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY, async (raw: unknown) => {
    const parsed = DirectSessionLinkEnsureRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionLinkEnsureResponse;
    return directSessionsError(
      'invalid_request',
      'upgrade_required',
    ) satisfies DirectSessionLinkEnsureResponse;
  });
}

// Stable cli-v0.2.1@b1d15a8a9c241737d1ca9b167459901e6259173a, preview
// cli-v0.2.2-preview.1775586717.26498@4913c1e533c872a0712ba1c25b3104fd470aacc2,
// and the inspected remote-dev@90361fd4244046882c3bdb337fdace5a4894bb15
// predecessor emit these unphased requests.
// Their payload cannot carry the durable operation/idempotency/author-intent
// authority required by current takeover, so retain parsing only and fail
// closed. Remove both aliases when supported clients and rollback targets no
// longer send them.
export function registerLegacyDirectSessionTakeoverWireAliases(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY, async (raw: unknown) => {
    const parsed = DirectSessionTakeoverRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionTakeoverResponse;
    return directSessionsError(
      'invalid_request',
      'upgrade_required',
    ) satisfies DirectSessionTakeoverResponse;
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY, async (raw: unknown) => {
    const parsed = DirectSessionTakeoverPersistRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionTakeoverPersistResponse;
    return directSessionsError(
      'invalid_request',
      'upgrade_required',
    ) satisfies DirectSessionTakeoverPersistResponse;
  });
}
