import { ConnectedServiceQuotaGetInputV1Schema, openProviderAccountUsageRecordV4, openProviderAccountUsageHistoryPageV4, projectProviderAccountUsageQuotaReadV1, ProviderAccountUsageReadErrorV1, type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1, type ProviderAccountUsageHistoryWitnessV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import type { StoredCredentials } from '@/persistence';
import type { UsagePacingTargetsV1 } from '@happier-dev/protocol/account/settings/usagePacingPreferencesV1';
import { resolveQualifiedProviderAccountUsageSourceV4, readQualifiedProviderAccountUsageRecordV4, readQualifiedProviderAccountUsageHistoryV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { ProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import type { PendingResetStartsReadInputV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { evaluatePendingResetStartReadinessV1 } from '@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1';
import { readPendingResetStartsForSource } from '@/api/session/pendingQueueV2Transport';
import axios from 'axios';
import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import type { ProviderAccountUsageWaitingWorkV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';

export type ProviderAccountUsageReadOptions = Readonly<{
  credentials: StoredCredentials;
  accountMode: 'plain' | 'e2ee';
  signal?: AbortSignal;
  nowMs?: number;
  targets?: UsagePacingTargetsV1;
  assertCurrent?: () => void | Promise<void>;
  authorizeRequest?: (request: Readonly<{ method: 'GET'; path: string }>) => Readonly<Record<string, string>> | null;
  authorizePendingReadRequest?: (request: Readonly<{ method: 'POST'; path: string; body: PendingResetStartsReadInputV1 }>) => Readonly<Record<string, string>> | null;
}>;
export async function readProviderAccountUsageQuotaV4(input: ConnectedServiceQuotaGetInputV1, options: ProviderAccountUsageReadOptions): Promise<ConnectedServiceQuotaGetResultV1> {
  const request = ConnectedServiceQuotaGetInputV1Schema.parse(input);
  await options.assertCurrent?.();
  const transport = { token: options.credentials.token, signal: options.signal, authorizeRequest: options.authorizeRequest };
  const resolution = await resolveQualifiedProviderAccountUsageSourceV4({ ...transport, source: request.source });
  await options.assertCurrent?.();
  const material = options.accountMode === 'e2ee' ? requireAccountEncryptionCredentials(options.credentials).encryption : undefined;
  const record = resolution ? await readQualifiedProviderAccountUsageRecordV4({ ...transport, recordId: resolution.recordId }) : null;
  await options.assertCurrent?.();
  const current = record && resolution ? openProviderAccountUsageRecordV4({ recordId: resolution.recordId, account: request.source.ref, accountMode: options.accountMode, material, record }) : null;
  if (current && resolution && current.recordKey.accountSubjectId !== resolution.providerAccountId) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
  const page = request.history && resolution ? await readQualifiedProviderAccountUsageHistoryV4({ ...transport, query: { recordId: resolution.recordId, history: request.history } }) : null;
  await options.assertCurrent?.();
  if (request.history && resolution && !page) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
  const { nowMs, waitingWork } = await readWaitingWork(request, current, options);
  return projectProviderAccountUsageQuotaReadV1({ input: request, current, ...(request.history ? { history: page && resolution ? openProviderAccountUsageHistoryPageV4({ recordId: resolution.recordId, accountMode: options.accountMode, material, page }) : { entries: [], nextCursor: null } } : {}), nowMs, targets: options.targets, waitingWork });
}

async function readWaitingWork(input: ConnectedServiceQuotaGetInputV1, current: ProviderAccountUsageSnapshotV1 | null, options: ProviderAccountUsageReadOptions): Promise<{ nowMs: number; waitingWork: ProviderAccountUsageWaitingWorkV1 }> {
  const finish = (waitingWork: ProviderAccountUsageWaitingWorkV1, nowMs = options.nowMs ?? Date.now()) => ({ nowMs, waitingWork });
  await options.assertCurrent?.();
  let pending;
  try {
    pending = await readPendingResetStartsForSource({ token: options.credentials.token, source: input.source, signal: options.signal, authorizeRequest: options.authorizePendingReadRequest });
  } catch (error) {
    if (options.signal?.aborted || axios.isCancel(error)) throw error;
    await options.assertCurrent?.();
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const admissionUnavailable = error instanceof Error && 'code' in error && error.code === 'admission_unavailable';
    return finish({ status: 'unavailable', reason: status === 404 || status === 405 ? 'unsupported' : admissionUnavailable || status === 401 || status === 403 ? 'authority_unavailable' : 'read_failed' });
  }
  await options.assertCurrent?.();
  const witnessedEntries = await Promise.all(pending.entries.map(async entry => {
    const witness = entry.authorityCurrent ? await readProviderAccountUsageHistoryWitnessV4({ recordId: entry.reset.recordId, witness: entry.reset.witness }, options) : null;
    return { entry, witness };
  }));
  await options.assertCurrent?.();
  // One post-read instant qualifies waiting work and pace; explicit as-of time
  // remains fixed even if a transport response or currentness check was held.
  const nowMs = options.nowMs ?? Date.now();
  const entries = witnessedEntries.map(({ entry, witness }) => ({
    sessionId: entry.sessionId, localId: entry.localId,
    recordId: entry.reset.recordId, meterId: entry.reset.meterId,
    readiness: evaluatePendingResetStartReadinessV1({ reset: entry.reset, witness, current, nowMs, authorityCurrent: entry.authorityCurrent }),
  }));
  return finish({ status: 'available', entries }, nowMs);
}

export async function readProviderAccountUsageHistoryWitnessV4(input: Readonly<{ recordId: ProviderAccountUsageRecordId; witness: ProviderAccountUsageHistoryWitnessV1 }>, options: ProviderAccountUsageReadOptions) {
  await options.assertCurrent?.();
  const page = await readQualifiedProviderAccountUsageHistoryV4({ token: options.credentials.token, query: input, signal: options.signal, authorizeRequest: options.authorizeRequest });
  await options.assertCurrent?.();
  if (!page) return null;
  const opened = openProviderAccountUsageHistoryPageV4({ recordId: input.recordId, accountMode: options.accountMode, material: options.accountMode === 'e2ee' ? requireAccountEncryptionCredentials(options.credentials).encryption : undefined, page });
  const entry = opened.entries.find(entry => entry.id === input.witness.id && entry.observedAtMs === input.witness.observedAtMs);
  if (!entry && opened.entries.length) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
  return entry?.snapshot ?? null;
}
