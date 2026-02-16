import {
  ConnectedServiceIdSchema,
  openConnectedServiceCredentialCiphertext,
  sealConnectedServiceQuotaSnapshotCiphertext,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

import type { ConnectedServiceQuotaFetcher } from './types';

type ConnectedServicesBindingsV1Like = Readonly<{
  v?: unknown;
  bindingsByServiceId?: Record<string, unknown>;
}>;

type QuotaApi = Readonly<{
  getConnectedServiceQuotaSnapshotSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
    | null
    | Readonly<{
        sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
        metadata: Readonly<{
          fetchedAt: number;
          staleAfterMs: number;
          status: 'ok' | 'unavailable' | 'estimated' | 'error';
          refreshRequestedAt?: number;
        }>;
      }>
  >;
  getConnectedServiceCredentialSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
    | null
    | Readonly<{
        sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
        metadata: Readonly<{ kind: string }>;
      }>
  >;
  registerConnectedServiceQuotaSnapshotSealed: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
    metadata: Readonly<{ fetchedAt: number; staleAfterMs: number; status: 'ok' | 'unavailable' | 'estimated' | 'error' }>;
  }>) => Promise<void>;
}>;

type SpawnTarget = Readonly<{
  pid: number;
  bindings: ConnectedServicesBindingsV1Like;
}>;

function extractActiveBindings(raw: ConnectedServicesBindingsV1Like): Array<{ serviceId: ConnectedServiceId; profileId: string }> {
  const out: Array<{ serviceId: ConnectedServiceId; profileId: string }> = [];
  const bindings = raw?.bindingsByServiceId ?? {};
  for (const [serviceId, binding] of Object.entries(bindings)) {
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(serviceId);
    if (!parsedServiceId.success) continue;
    const bindingObj = binding && typeof binding === 'object' ? (binding as Record<string, unknown>) : null;
    const source = typeof bindingObj?.source === 'string' ? String(bindingObj.source) : '';
    if (source !== 'connected') continue;
    const profileId = typeof bindingObj?.profileId === 'string' ? String(bindingObj.profileId) : '';
    if (!profileId.trim()) continue;
    out.push({ serviceId: parsedServiceId.data, profileId });
  }
  return out;
}

function deriveQuotaSnapshotStatus(snapshot: ConnectedServiceQuotaSnapshotV1): 'ok' | 'unavailable' | 'estimated' {
  const meters = Array.isArray(snapshot.meters) ? snapshot.meters : [];
  if (meters.length === 0) return 'ok';
  const statuses = meters.map((m: any) => (typeof m?.status === 'string' ? m.status : ''));
  if (statuses.every((s) => s === 'unavailable')) return 'unavailable';
  if (statuses.some((s) => s === 'estimated')) return 'estimated';
  return 'ok';
}

export class ConnectedServiceQuotasCoordinator {
  private readonly api: QuotaApi;
  private readonly credentials: Credentials;
  private readonly quotaFetchersByServiceId: Map<ConnectedServiceId, ConnectedServiceQuotaFetcher>;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly fetchTimeoutMs: number;
  private readonly spawnTargetsByPid = new Map<number, SpawnTarget>();

  public constructor(params: Readonly<{
    api: QuotaApi;
    credentials: Credentials;
    quotaFetchers: ReadonlyArray<ConnectedServiceQuotaFetcher>;
    now: () => number;
    randomBytes: (length: number) => Uint8Array;
    fetchTimeoutMs?: number;
  }>) {
    this.api = params.api;
    this.credentials = params.credentials;
    this.now = params.now;
    this.randomBytes = params.randomBytes;
    this.quotaFetchersByServiceId = new Map(params.quotaFetchers.map((f) => [f.serviceId, f]));
    this.fetchTimeoutMs =
      typeof params.fetchTimeoutMs === 'number' && Number.isFinite(params.fetchTimeoutMs)
        ? Math.max(1, Math.trunc(params.fetchTimeoutMs))
        : 15_000;
  }

  public registerSpawnTarget(params: Readonly<{
    pid: number;
    connectedServicesBindingsRaw: ConnectedServicesBindingsV1Like;
  }>): void {
    const pid = Math.trunc(Number(params.pid));
    if (!Number.isFinite(pid) || pid <= 0) return;
    this.spawnTargetsByPid.set(pid, { pid, bindings: params.connectedServicesBindingsRaw ?? {} });
  }

  public unregisterPid(pidRaw: number): void {
    const pid = Math.trunc(Number(pidRaw));
    if (!Number.isFinite(pid) || pid <= 0) return;
    this.spawnTargetsByPid.delete(pid);
  }

  public async tickOnce(): Promise<void> {
    const now = Math.max(0, Math.trunc(this.now()));
    const encryption = this.credentials.encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });

    const bindingsByServiceId = new Map<ConnectedServiceId, Set<string>>();
    for (const target of this.spawnTargetsByPid.values()) {
      for (const entry of extractActiveBindings(target.bindings)) {
        const profileId = String(entry.profileId ?? '').trim();
        if (!profileId) continue;
        const existing = bindingsByServiceId.get(entry.serviceId);
        if (existing) {
          existing.add(profileId);
        } else {
          bindingsByServiceId.set(entry.serviceId, new Set([profileId]));
        }
      }
    }

    for (const [serviceId, profileIds] of bindingsByServiceId.entries()) {
      const fetcher = this.quotaFetchersByServiceId.get(serviceId);
      if (!fetcher) continue;

      for (const profileId of profileIds) {
        try {
          const existing = await this.api.getConnectedServiceQuotaSnapshotSealed({ serviceId, profileId });
          if (existing?.metadata) {
            const fetchedAt = Number(existing.metadata.fetchedAt ?? 0);
            const staleAfterMs = Number(existing.metadata.staleAfterMs ?? 0);
            const refreshRequestedAt = Number(existing.metadata.refreshRequestedAt ?? 0);
            if (Number.isFinite(fetchedAt) && Number.isFinite(staleAfterMs) && fetchedAt > 0 && staleAfterMs > 0) {
              const forcedRefresh =
                Number.isFinite(refreshRequestedAt) &&
                refreshRequestedAt > 0 &&
                refreshRequestedAt > fetchedAt;
              if (!forcedRefresh && now < fetchedAt + staleAfterMs) continue;
            }
          }

          const sealedCred = await this.api.getConnectedServiceCredentialSealed({ serviceId, profileId });
          if (!sealedCred?.sealed?.ciphertext) continue;

          const opened = openConnectedServiceCredentialCiphertext({ material, ciphertext: sealedCred.sealed.ciphertext });
          const record = opened?.value as ConnectedServiceCredentialRecordV1 | null | undefined;
          if (!record) continue;

          const controller = new AbortController();
          const timeoutMs = this.fetchTimeoutMs;

          const fetchPromise = fetcher.fetch({ record, now, signal: controller.signal });

          let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
          const timeoutPromise = new Promise<{ type: 'timeout' }>((resolve) => {
            timeoutHandle = setTimeout(() => {
              try {
                controller.abort('quota-fetch-timeout');
              } catch {
                // ignore
              }
              resolve({ type: 'timeout' });
            }, timeoutMs);
            (timeoutHandle as unknown as { unref?: () => void })?.unref?.();
          });

          const raced = await Promise.race([
            fetchPromise.then(
              (snapshot) => ({ type: 'result' as const, snapshot }),
              (error) => ({ type: 'error' as const, error }),
            ),
            timeoutPromise,
          ]);

          if (timeoutHandle) clearTimeout(timeoutHandle);
          timeoutHandle = null;

          if (raced.type === 'timeout') {
            // Best-effort only: ignore late results. The AbortController should be enough for well-behaved fetchers.
            continue;
          }
          if (raced.type === 'error') {
            throw raced.error;
          }

          const snapshot = raced.snapshot;
          if (!snapshot) continue;

          const sealed = sealConnectedServiceQuotaSnapshotCiphertext({
            material,
            payload: snapshot,
            randomBytes: this.randomBytes,
          });

          const status = deriveQuotaSnapshotStatus(snapshot);
          await this.api.registerConnectedServiceQuotaSnapshotSealed({
            serviceId,
            profileId,
            sealed: { format: 'account_scoped_v1', ciphertext: sealed },
            metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status },
          });
        } catch {
          // Best-effort only.
          continue;
        }
      }
    }
  }
}
