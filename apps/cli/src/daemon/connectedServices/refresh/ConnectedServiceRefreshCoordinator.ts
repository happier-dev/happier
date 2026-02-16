import {
  ConnectedServiceCredentialRecordV1Schema,
  openConnectedServiceCredentialCiphertext,
  sealConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import { randomBytes } from 'node:crypto';

import type { ApiClient } from '@/api/api';
import type { CatalogAgentId } from '@/backends/types';
import type { Credentials } from '@/persistence';

import { parseConnectedServicesBindings } from '../parseConnectedServicesBindings';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { materializeConnectedServicesForSpawn } from '../materialize/materializeConnectedServicesForSpawn';
import { refreshAnthropicOauthTokens, refreshGeminiOauthTokens, refreshOpenAiCodexOauthTokens } from './serviceRefreshers';

type BoundProfile = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;

type SpawnTarget = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
  materializationKey: string;
  bindings: ReadonlyArray<BoundProfile>;
}>;

function bindingKey(binding: BoundProfile): string {
  return `${binding.serviceId}/${binding.profileId}`;
}

function openConnectedServiceRecord(params: Readonly<{
  credentials: Credentials;
  ciphertext: string;
}>): ConnectedServiceCredentialRecordV1 {
  const opened = openConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    ciphertext: params.ciphertext,
  });
  if (!opened || !opened.value) {
    throw new Error('Failed to decrypt connected service credential');
  }
  return ConnectedServiceCredentialRecordV1Schema.parse(opened.value);
}

function buildUpdatedOauthRecord(params: Readonly<{
  now: number;
  record: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' };
  next: Readonly<{
    accessToken: string;
    refreshToken: string;
    idToken: string | null;
    expiresAt: number | null;
  }>;
}>): ConnectedServiceCredentialRecordV1 {
  return ConnectedServiceCredentialRecordV1Schema.parse({
    ...params.record,
    updatedAt: params.now,
    expiresAt: params.next.expiresAt,
    oauth: {
      ...params.record.oauth,
      accessToken: params.next.accessToken,
      refreshToken: params.next.refreshToken,
      idToken: params.next.idToken ?? params.record.oauth.idToken,
    },
  });
}

export class ConnectedServiceRefreshCoordinator {
  private readonly targetsByPid = new Map<number, SpawnTarget>();

  constructor(private readonly params: Readonly<{
    api: ApiClient;
    credentials: Credentials;
    machineIdProvider: () => string;
    baseDir: string;
    refreshWindowMs: number;
    refreshLeaseMs: number;
    now: () => number;
    onAuthUpdated?: (event: Readonly<{ binding: BoundProfile; affectedTargets: ReadonlyArray<SpawnTarget> }>) => void | Promise<void>;
  }>) {}

  registerSpawnTarget(params: Readonly<{
    pid: number;
    agentId: CatalogAgentId;
    materializationKey: string;
    connectedServicesBindingsRaw: unknown;
  }>): void {
    const bindings = parseConnectedServicesBindings(params.connectedServicesBindingsRaw);
    if (bindings.length === 0) return;
    this.targetsByPid.set(params.pid, {
      pid: params.pid,
      agentId: params.agentId,
      materializationKey: params.materializationKey,
      bindings,
    });
  }

  unregisterPid(pid: number): void {
    this.targetsByPid.delete(pid);
  }

  async tickOnce(): Promise<void> {
    const now = this.params.now();
    const unique = new Map<string, BoundProfile>();

    for (const target of this.targetsByPid.values()) {
      for (const binding of target.bindings) {
        unique.set(bindingKey(binding), binding);
      }
    }

    for (const binding of unique.values()) {
      await this.maybeRefreshBinding(binding, now);
    }
  }

  private async maybeRefreshBinding(binding: BoundProfile, now: number): Promise<void> {
    const sealed = await this.params.api.getConnectedServiceCredentialSealed({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
    });
    if (!sealed) return;

    const expiresAt = sealed.metadata?.expiresAt ?? null;
    if (sealed.metadata?.kind !== 'oauth') return;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return;
    if (expiresAt - now > this.params.refreshWindowMs) return;

    const machineId = this.params.machineIdProvider();
    if (!machineId) return;

    const lease = await this.params.api.acquireConnectedServiceRefreshLease({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
      machineId,
      leaseMs: this.params.refreshLeaseMs,
    });
    if (!lease.acquired) return;

    const record = openConnectedServiceRecord({
      credentials: this.params.credentials,
      ciphertext: sealed.sealed.ciphertext,
    });
    if (record.kind !== 'oauth') return;

    const next = await (async () => {
      if (binding.serviceId === 'openai-codex') {
        const refreshed = await refreshOpenAiCodexOauthTokens({
          refreshToken: record.oauth.refreshToken,
          now,
        });
        return {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          idToken: refreshed.idToken,
          expiresAt: refreshed.expiresAt,
        };
      }
      if (binding.serviceId === 'anthropic') {
        const refreshed = await refreshAnthropicOauthTokens({
          refreshToken: record.oauth.refreshToken,
          now,
        });
        return {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          idToken: record.oauth.idToken,
          expiresAt: refreshed.expiresAt,
        };
      }
      if (binding.serviceId === 'gemini') {
        const refreshed = await refreshGeminiOauthTokens({
          refreshToken: record.oauth.refreshToken,
          now,
        });
        return {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          idToken: refreshed.idToken,
          expiresAt: refreshed.expiresAt,
        };
      }
      return null;
    })();
    if (!next) return;

    const updated = buildUpdatedOauthRecord({
      now,
      record,
      next,
    });

    const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
      material:
        this.params.credentials.encryption.type === 'legacy'
          ? { type: 'legacy', secret: this.params.credentials.encryption.secret }
          : { type: 'dataKey', machineKey: this.params.credentials.encryption.machineKey },
      payload: updated,
      randomBytes: (length) => randomBytes(length),
    });

    await this.params.api.registerConnectedServiceCredentialSealed({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
      metadata: {
        kind: updated.kind,
        providerEmail: updated.kind === 'oauth' ? updated.oauth.providerEmail : null,
        providerAccountId: updated.kind === 'oauth' ? updated.oauth.providerAccountId : null,
        expiresAt: updated.expiresAt,
      },
    });

    const affectedTargets = await this.rematerializeTargetsForBinding(binding);
    await this.params.onAuthUpdated?.({ binding, affectedTargets });
  }

  private async rematerializeTargetsForBinding(binding: BoundProfile): Promise<ReadonlyArray<SpawnTarget>> {
    const affected = Array.from(this.targetsByPid.values()).filter((target) =>
      target.bindings.some((b) => b.serviceId === binding.serviceId && b.profileId === binding.profileId),
    );
    for (const target of affected) {
      const records = await resolveConnectedServiceCredentials({
        credentials: this.params.credentials,
        api: this.params.api,
        bindings: target.bindings,
      });
      await materializeConnectedServicesForSpawn({
        agentId: target.agentId,
        materializationKey: target.materializationKey,
        baseDir: this.params.baseDir,
        recordsByServiceId: records,
      });
    }
    return affected;
  }
}
