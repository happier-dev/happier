import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';

import type { StoredCredentials } from '@/persistence';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { listPendingQueueV2ResetStartDemands, readPendingResetStartsForSource } from '@/api/session/pendingQueueV2Transport';
import { runWithServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { deterministicStringify } from '@/utils/deterministicJson';
import type { RequesterSessionRuntimeContext, ResolveRequesterSessionRuntimeContext } from '../../sessionEncryption/requesterSessionCredentials';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { readProviderAccountUsageHistoryWitnessV4, readProviderAccountUsageQuotaV4 } from '../accountUsage/readQuota';
import type { PendingResetStartDemand, PendingResetStartRecoveryPorts } from './UsageLimitRecoveryScheduler';

/** Read adapters preserve the Session owner, Machine, Account mode and qualified B authority. */
export function createPendingResetStartRecoveryPorts(input: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  isCurrent: () => boolean;
  resolveRequesterSessionRuntimeContext?: ResolveRequesterSessionRuntimeContext;
  releaseRequesterSessionRuntimeContext?: (context: RequesterSessionRuntimeContext) => Promise<void>;
  release: (demand: PendingResetStartDemand & Readonly<{ sessionId: string }>) => Promise<void>;
  onError: (error: unknown) => void;
}>): PendingResetStartRecoveryPorts {
  return {
    withSession: async (sessionId, run, signal) => {
      signal?.throwIfAborted();
      if (!input.isCurrent()) return;
      const releaseRequesterContext = input.releaseRequesterSessionRuntimeContext;
      const context = input.resolveRequesterSessionRuntimeContext && releaseRequesterContext
        ? await input.resolveRequesterSessionRuntimeContext(sessionId, undefined, signal) : null;
      try {
        const credentials = context?.bootstrap.credentials ?? input.credentials;
        const serverUrl = context?.bootstrap.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
        signal?.throwIfAborted();
        if (context && (context.bootstrap.getBoundSessionId() !== sessionId
          || context.bootstrap.attribution.machineId !== input.machineId || !await context.isCurrent(signal))) return;
        await runWithServerHttpBaseUrl(serverUrl, async () => {
          signal?.throwIfAborted();
          const authority = await fetchAccountEncryptionCurrentness({ credentials: credentials, token: credentials.token, signal });
          signal?.throwIfAborted();
          const rawSession = await fetchSessionById({ reason: 'session-control', token: credentials.token, sessionId, signal });
          signal?.throwIfAborted();
          if (!rawSession || rawSession.id !== sessionId
            || readSessionAccessProjectionRoleV1(rawSession) !== 'owner' || rawSession.archivedAt != null) return;
          const metadata = tryDecryptSessionOwnerMetadataView({ credentials, rawSession, accountEncryptionMode: authority.mode });
          if (metadata?.machineId !== input.machineId) return;
          // These shared readers retain cancellation between HTTP phases;
          // Session currentness was already decided at this wake's admission.
          const readOptions = { credentials, accountMode: authority.mode, signal,
            assertCurrent: async () => { signal?.throwIfAborted(); } };
          await run({
            read: async () => {
              signal?.throwIfAborted();
              return await listPendingQueueV2ResetStartDemands({ token: credentials.token, sessionId, signal });
            },
            readAuthority: async demand => {
              signal?.throwIfAborted();
              const projection = await readPendingResetStartsForSource({ token: credentials.token, source: demand.reset.source, signal });
              return projection.entries.some(entry => entry.sessionId === sessionId
                && entry.localId === demand.localId && entry.authorityCurrent
                && deterministicStringify(entry.reset) === deterministicStringify(demand.reset));
            },
            readWitness: reset => readProviderAccountUsageHistoryWitnessV4({ recordId: reset.recordId, witness: reset.witness },
              readOptions),
            readCurrent: async reset => (await readProviderAccountUsageQuotaV4({ source: reset.source },
              readOptions)).current,
            release: async demand => {
              signal?.throwIfAborted();
              // Installed Machine owner rechecks exact retained target and Pending CAS.
              await input.release({ sessionId, ...demand });
            },
          });
        });
      } finally {
        // This owner preserves borrowed tracked contexts and releases only temporary recovery.
        if (context && releaseRequesterContext) await releaseRequesterContext(context);
      }
    },
    onError: input.onError,
  };
}
