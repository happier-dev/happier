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
    withSession: async (sessionId, run) => {
      if (!input.isCurrent()) return;
      const releaseRequesterContext = input.releaseRequesterSessionRuntimeContext;
      const context = input.resolveRequesterSessionRuntimeContext && releaseRequesterContext
        ? await input.resolveRequesterSessionRuntimeContext(sessionId) : null;
      try {
        const credentials = context?.bootstrap.credentials ?? input.credentials;
        const serverUrl = context?.bootstrap.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
        const isCurrent = async () => input.isCurrent() && (!context
          || context.bootstrap.getBoundSessionId() === sessionId && context.bootstrap.attribution.machineId === input.machineId
            && await context.isCurrent());
        await runWithServerHttpBaseUrl(serverUrl, async () => {
          if (!await isCurrent()) return;
          const authority = await fetchAccountEncryptionCurrentness({ token: credentials.token });
          const rawSession = await fetchSessionById({ token: credentials.token, sessionId });
          if (!await isCurrent() || !rawSession || rawSession.id !== sessionId
            || readSessionAccessProjectionRoleV1(rawSession) !== 'owner' || rawSession.archivedAt != null) return;
          const metadata = tryDecryptSessionOwnerMetadataView({ credentials, rawSession, accountEncryptionMode: authority.mode });
          if (metadata?.machineId !== input.machineId) return;
          const assertCurrent = async () => { if (!await isCurrent()) throw new Error('requester_session_not_current'); };
          await run({
            isCurrent,
            read: async () => {
              const rows = await listPendingQueueV2ResetStartDemands({ token: credentials.token, sessionId });
              return await isCurrent() ? rows : [];
            },
            readAuthority: async demand => {
              const projection = await readPendingResetStartsForSource({ token: credentials.token, source: demand.reset.source });
              return await isCurrent() && projection.entries.some(entry => entry.sessionId === sessionId
                && entry.localId === demand.localId && entry.authorityCurrent
                && deterministicStringify(entry.reset) === deterministicStringify(demand.reset));
            },
            readWitness: reset => readProviderAccountUsageHistoryWitnessV4({ recordId: reset.recordId, witness: reset.witness },
              { credentials, accountMode: authority.mode, assertCurrent }),
            readCurrent: async reset => (await readProviderAccountUsageQuotaV4({ source: reset.source },
              { credentials, accountMode: authority.mode, assertCurrent })).current,
            release: async demand => {
              if (!input.isCurrent()) throw new Error('requester_session_not_current');
              // Installed Machine owner rechecks exact retained target and Pending CAS.
              await input.release({ sessionId, ...demand });
              await assertCurrent();
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
