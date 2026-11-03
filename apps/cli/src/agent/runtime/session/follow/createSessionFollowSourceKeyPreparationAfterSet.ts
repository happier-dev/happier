import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { SessionFollowSourceKeyPreparationResultV1, SessionFollowSourceKeyPreparationWaitingCauseV1 } from '@happier-dev/protocol';

import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import type { ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { resolveSessionOwningMachineId } from '@/session/services/resolveSessionOwningMachine';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { isAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { logger } from '@/ui/logger';

import { prepareSessionFollowSourceKey } from './prepareSessionFollowSourceKey';

/** The shared Session transport adapter wraps Account currentness failures; the HTTP status stays on the cause chain. */
function readCauseChainHttpStatus(error: unknown): number | null {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === 'object' && !seen.has(current);
    current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    const status = readHttpStatus(current);
    if (status !== null) return status;
  }
  return null;
}

export type SessionFollowSourceKeyPreparationAfterSet = (input: Readonly<{
  sourceSessionId: string;
  destinationSessionId: string;
  /** Exact existing Pending/materialized input; private witnesses stay server-side. */
  localInputId?: string;
  context: ActionExecutorContext;
  signal?: AbortSignal;
}>) => Promise<SessionFollowSourceKeyPreparationResultV1>;

/**
 * Binds the shared post-commit context-relation preparation leaf to one authenticated
 * Account/Home runtime. The public edge mutation remains committed when this
 * optional preparation cannot run; the family adapter projects that partial
 * completion as an explicit waiting result.
 */
export function createSessionFollowSourceKeyPreparationAfterSet(input: Readonly<{
  credentials: StoredCredentials;
  effectActionId?: 'follow.set' | 'session.manager.set' | 'session.spawn_new';
  serverHttpBaseUrl?: string;
  serverIdentityId?: string;
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
  externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
  externalActionMachineInstallationId?: string;
}>): SessionFollowSourceKeyPreparationAfterSet {
  const serverHttpBaseUrl = normalizeServerHttpBaseUrl(input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl());
  const effectActionId = input.effectActionId ?? 'follow.set';

  return async ({ sourceSessionId, destinationSessionId, localInputId, context, signal }) => await runWithServerHttpBaseUrl(
    serverHttpBaseUrl,
    async () => {
      // Active-Home Action composition enriches the invocation context from
      // the authenticated feature snapshot. Reuse that identity when the
      // constructor was created before the snapshot was available; fixed-Home
      // executors still retain their explicitly bound identity as authority.
      const homeServerIdentityId = input.serverIdentityId ?? context.serverIdentityId;
      const resolveAuthorizationHeaders = (request: Readonly<{
        method: 'GET' | 'POST';
        path: string;
        body?: unknown;
      }>): Readonly<Record<string, string>> | null => {
        const resolved = resolveExternalActionServerRequestHeaders({
          context,
          effectActionId,
          method: request.method,
          path: request.path,
          ...(request.body === undefined ? {} : { body: request.body }),
          daemonToken: input.credentials.token,
          ...(homeServerIdentityId ? { serverIdentityId: homeServerIdentityId } : {}),
          ...(input.externalActionMachineRequestPrivateKey
            ? { privateKey: input.externalActionMachineRequestPrivateKey }
            : {}),
          ...(input.externalActionMachineInstallationId
            ? { installationId: input.externalActionMachineInstallationId }
            : {}),
        });
        return resolved.ok ? resolved.headers : null;
      };
      const transportFailed = (cause: 'source_transport_exception' | 'destination_transport_exception', error: unknown) => {
        signal?.throwIfAborted();
        // Keep the typed HTTP cause; never serialize messages, bodies, URLs,
        // request config, headers or arbitrary native error codes.
        const httpStatus = readCauseChainHttpStatus(error);
        try {
          logger.warnLocalFile('[Session Follow source-key preparation] Transport refused', {
            cause, httpStatus, errorCode: isAuthenticationStatus(httpStatus) ? 'not_authenticated' : 'transport_exception',
          });
        } catch { /* Diagnostics cannot change the committed relation's result. */ }
        return null;
      };

      let exceptionCause: SessionFollowSourceKeyPreparationWaitingCauseV1 = 'server_features_exception';
      try {
        const serverFeaturesSnapshot = await input.resolveServerFeaturesSnapshot?.();
        const [source, destination] = await Promise.all([
          resolveSessionTransportContext({ reason: 'follow-source-hydration',
            credentials: input.credentials,
            idOrPrefix: sourceSessionId,
            resolveAuthorizationHeaders,
            ...(signal ? { signal } : {}),
            ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
          }).catch(error => transportFailed('source_transport_exception', error)),
          resolveSessionTransportContext({ reason: 'follow-source-hydration',
            credentials: input.credentials,
            idOrPrefix: destinationSessionId,
            resolveAuthorizationHeaders,
            ...(signal ? { signal } : {}),
            ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
          }).catch(error => transportFailed('destination_transport_exception', error)),
        ]);
        if (!source) return { kind: 'waiting', reason: 'runner_unreachable', cause: 'source_transport_exception' };
        if (!destination) return { kind: 'waiting', reason: 'runner_unreachable', cause: 'destination_transport_exception' };
        if (!source.ok) return { kind: 'waiting', reason: 'source_key_unavailable', cause: 'source_transport_unavailable' };
        if (!destination.ok) return { kind: 'waiting', reason: 'runner_unreachable', cause: 'destination_transport_unavailable' };
        if (source.mode === 'plain') return { kind: 'not_needed' };
        // Cooperative Follow may transfer only the standalone Session DEK opened
        // from this Session's published envelope. The general transport resolver
        // deliberately retains released absent-envelope Account-key fallback for
        // ordinary Session reads; that compatibility key must never be exported
        // as source material to another runtime.
        exceptionCause = 'source_key_exception';
        const sourceDataEncryptionKey = openSessionDataEncryptionKey({
          credential: input.credentials,
          encryptedDataEncryptionKeyBase64: source.rawSession.dataEncryptionKey,
        });
        // An Account-backed persistent daemon already reads Session content
        // through its ordinary credentials. Only the exact Runner class needs
        // this standalone key; the Machine RPC owner decides that before it
        // constructs any private key-transfer request.
        try {
          if (!homeServerIdentityId) {
            return { kind: 'waiting', reason: 'runner_unreachable', cause: 'home_identity_unavailable' };
          }

          exceptionCause = 'destination_machine_exception';
          const destinationMachine = resolveSessionOwningMachineId({
            credentials: input.credentials,
            rawSession: destination.rawSession,
            accountEncryptionMode: destination.accountEncryptionCurrentness.mode,
          });
          if (!destinationMachine.ok) {
            return { kind: 'waiting', reason: 'runner_unreachable', cause: 'destination_machine_unresolved' };
          }
          if (!destinationMachine.machineId) {
            return { kind: 'waiting', reason: 'runner_unreachable', cause: 'destination_machine_missing' };
          }

          const externalAction = context.externalActionExecutionAuthorization
            && input.externalActionMachineInstallationId
            && input.externalActionMachineRequestPrivateKey
            ? {
                context,
                effectActionId,
                installationId: input.externalActionMachineInstallationId,
                privateKey: input.externalActionMachineRequestPrivateKey,
              }
            : undefined;

          exceptionCause = 'preparation_exception';
          return await prepareSessionFollowSourceKey({
            credentials: input.credentials,
            homeServerIdentityId,
            machineId: destinationMachine.machineId,
            sourceSessionId,
            destinationSessionId,
            ...(localInputId !== undefined ? { localInputId } : {}),
            sourceDataEncryptionKey,
            serverUrl: serverHttpBaseUrl,
            ...(signal ? { signal } : {}),
            ...(externalAction ? { externalAction } : {}),
          });
        } finally {
          // The opened Session DEK is sender-owned scratch material for this one
          // preparation attempt: zero it once the post-open outcome is decided.
          // The preparer encodes the original bytes before its RPC and retains no
          // reference; caller-owned and receiver-owned key material is never
          // cleared here.
          sourceDataEncryptionKey?.fill(0);
        }
      } catch {
        signal?.throwIfAborted();
        return { kind: 'waiting', reason: 'runner_unreachable', cause: exceptionCause };
      }
    },
  );
}
