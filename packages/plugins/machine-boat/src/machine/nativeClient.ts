import { projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as mini from 'zod/mini';
import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import {
  BoatAcquireOperationV1Schema,
  BoatDeleteOperationV1Schema,
  BoatLaunchV1Schema,
  BoatNativeError,
  BoatPublicKeySchema,
  BoatResourceV1Schema,
  isBoatAdmissionRefusalCode,
  parseBoatValue,
  type BoatAcquireOperationV1,
  type BoatDeleteOperationV1,
  type BoatLaunchV1,
  type BoatResourceV1,
} from './schemas.js';

const API_ORIGIN = 'https://boat.dev/api/v1';
const text = () => mini.string().check(mini.trim(), mini.minLength(1));
const sandboxId = mini.string().check(mini.regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/));
const base = { ok: mini.literal(true), type: text() } as const;
const nativeDate = () => mini.optional(mini.nullable(mini.iso.datetime({ offset: true })));
const sandbox = mini.object({ id: sandboxId, name: mini.optional(text()), state: text(),
  health: mini.optional(mini.enum(['ok', 'degraded'])),
  ttlSeconds: mini.optional(mini.nullable(mini.number().check(mini.int(), mini.positive()))),
  archiveAfter: nativeDate(), dataExpiredAt: nativeDate(), stoppedAt: nativeDate() });
export const BoatLimitsResponseSchema = mini.object({ ...base, sandboxPlanKey: mini.optional(text()), sandboxPlanDollars: mini.optional(mini.number().check(mini.nonnegative())) });
export const BoatSavedSnapshotSchema = mini.object({
  name: mini.string().check(mini.regex(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  status: mini.enum(['saving', 'ready', 'failed']), sourceSandboxId: sandboxId, createdAt: text(), snapshotId: mini.optional(text()),
});
const snapshotsResponse = mini.object({ ...base, snapshots: mini.array(BoatSavedSnapshotSchema) });
const pageInfo = mini.optional(mini.object({ hasMore: mini.boolean(), nextCursor: mini.nullable(text()) }));
const sandboxesResponse = mini.object({ ...base, sandboxes: mini.array(sandbox), pageInfo });
const recoveryResponse = mini.object({ ...base, sandboxes: mini.array(mini.object({ id: sandboxId })), pageInfo });
const sandboxResponse = mini.object({ ...base, sandbox });
const createResponse = mini.object({ ok: mini.literal(true), sandbox: mini.object({ id: sandboxId }) });
const sshResponse = mini.object({ ...base, success: mini.literal(true), machineIp: mini.nullable(text()),
  sshEndpoint: mini.optional(mini.nullable(text())), sshUser: mini.literal('user'), hostKey: text() });
const deletionOperation = mini.object({
  id: mini.string().check(mini.regex(/^bdop_[a-f0-9]{32}$/)), kind: mini.literal('sandbox'), targetId: sandboxId,
  status: mini.enum(['pending', 'processing', 'blocked', 'completed']),
});
const deletionResponse = mini.object({ ...base, operation: deletionOperation });
const errorResponse = mini.object({ ok: mini.literal(false), code: text() });

export type BoatSize = Readonly<{ id: BoatLaunchV1['size']; multiplier: number; cpuCores: number; memoryGb: number; diskGb: number; hourlyUsd: string }>;
export type BoatOptions = Readonly<{
  sandboxPlanKey?: string;
  sizes: readonly BoatSize[];
  snapshots: readonly Readonly<{ name: string; status: 'ready' }>[];
  sandboxes: readonly Readonly<{ id: string; name?: string; state: string }>[];
}>;
export type BoatAcquireResult =
  | Readonly<{ kind: 'bound'; resource: BoatResourceV1; ready: boolean }>
  | Readonly<{ kind: 'pending'; operation: BoatAcquireOperationV1; nativeCause?: MachineProvisionerNativeCauseV1 }>
  | Readonly<{ kind: 'unknown'; code: string; nativeCause?: MachineProvisionerNativeCauseV1 }>
  | Readonly<{ kind: 'refused'; code: string; nativeCause?: MachineProvisionerNativeCauseV1 }>;
export type BoatNativeClientOptions = Readonly<{ fetch?: typeof globalThis.fetch; signal?: AbortSignal }>;

// Boat snapshots/stop.md: archived user disks are deleted 14 days after native Stop.
export const BOAT_STOPPED_STORAGE_NOTICE = { kind: 'stopped-storage',
  rule: { kind: 'after-stop', afterMs: 14 * 24 * 60 * 60 * 1000 }, consequence: 'disk-deleted' } as const;

const BASE_SIZES: readonly BoatSize[] = [
  { id: 'small', multiplier: 0.5, cpuCores: 2, memoryGb: 4, diskGb: 51, hourlyUsd: '0.018' },
  { id: 'default', multiplier: 1, cpuCores: 4, memoryGb: 8, diskGb: 51, hourlyUsd: '0.036' },
  { id: 'large', multiplier: 2, cpuCores: 8, memoryGb: 16, diskGb: 111, hourlyUsd: '0.072' },
];
const XLARGE: BoatSize = { id: 'xlarge', multiplier: 5.56, cpuCores: 16, memoryGb: 32, diskGb: 251, hourlyUsd: '0.200' };

// Trial accounts require a numeric TTL of at most two hours. PATCH resets the
// wall deadline; guest activity does not. https://docs.boat.dev/long-running-tasks/auto-stop.md
const TRIAL_TTL_SECONDS = 2 * 60 * 60;
function endpoint(launch: BoatLaunchV1, managedId: string, ttlSeconds: number | null): { path: string; body: Readonly<Record<string, unknown>> } {
  // CreateSandboxRequest.labels and fork labels: https://docs.boat.dev/openapi/boat-v1.yaml
  const common = { type: launch.size, snapshots: true, noEnv: true, ttlSeconds, labels: { 'happier-managed-id': managedId } } as const;
  if (launch.source.kind === 'blank') return { path: '/sandboxes', body: common };
  if (launch.source.kind === 'named-snapshot') return { path: '/sandboxes', body: { ...common, from: launch.source.name } };
  return { path: `/sandboxes/${encodeURIComponent(launch.source.sandboxId)}/fork`, body: common };
}

export function createBoatNativeRequest(options: BoatNativeClientOptions = {}) {
  const transport = options.fetch ?? globalThis.fetch;

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await transport(`${API_ORIGIN}${path}`, { ...init, redirect: 'error', signal: options.signal });
    } catch (error) {
      const transportFailure = (): never => {
          throw new BoatNativeError('native_transport_unavailable');
        };
      return (init.method ?? 'GET') === 'GET' ? projectMachineProvisionerActionFailure(error, transportFailure) : transportFailure();
    }
    // The response class is observed at the HTTP boundary. Vendor bodies and
    // messages are never diagnostic carriers, including undecodable refusals.
    const nativeCause: MachineProvisionerNativeCauseV1 | undefined = response.ok ? undefined : {
      httpStatusClass: response.status >= 500 ? '5xx' : response.status >= 400 ? '4xx' : response.status >= 300 ? '3xx' : 'other',
    };
    let value: unknown;
    try { value = await response.json(); } catch { throw new BoatNativeError('native_response_invalid', nativeCause); }
    if (!response.ok) {
      const parsed = errorResponse.safeParse(value);
      if (!parsed.success) throw new BoatNativeError('native_response_invalid', nativeCause);
      const error = parsed.data;
      // Only a completed client refusal disproves allocation. A timeout or
      // server failure can follow a committed create, regardless of its code.
      if (response.status === 408) throw new BoatNativeError('native_transport_unavailable', nativeCause);
      if (response.status >= 500) throw new BoatNativeError('native_service_unavailable', nativeCause);
      if (response.status < 400) throw new BoatNativeError('native_response_invalid', nativeCause);
      if (response.status === 401 || error.code === 'unauthorized') throw new BoatNativeError('native_authorization_failed', nativeCause);
      if (error.code === 'idempotency_in_progress') throw new BoatNativeError('native_idempotency_in_progress', nativeCause);
      if (error.code === 'idempotency_key_reused') throw new BoatNativeError('native_idempotency_mismatch', nativeCause);
      const nativeCode = `native_${error.code}`;
      if (isBoatAdmissionRefusalCode(nativeCode)) {
        throw new BoatNativeError(nativeCode, nativeCause);
      }
      if (response.status === 429 || error.code === 'rate_limited') throw new BoatNativeError('native_rate_limited', nativeCause);
      if (response.status === 404 && error.code === 'not_found') throw new BoatNativeError('native_not_found', nativeCause);
      throw new BoatNativeError('native_request_failed', nativeCause);
    }
    return value;
  }

  return request;
}

export function createBoatNativeClient(options: BoatNativeClientOptions = {}) {
  const request = createBoatNativeRequest(options);
  async function accountTtlSeconds() {
    const limits = parseBoatValue(BoatLimitsResponseSchema, await request('/limits'));
    if (limits.sandboxPlanKey === undefined) throw new BoatNativeError('native_response_invalid');
    return limits.sandboxPlanKey === 'trial' ? TRIAL_TTL_SECONDS : null;
  }
  return {
    async check() {
      parseBoatValue(BoatLimitsResponseSchema, await request('/limits'));
      return { available: true as const };
    },
    async options(): Promise<BoatOptions> {
      const [limitsValue, snapshotsValue, firstSandboxesValue] = await Promise.all([
        request('/limits'), request('/saved-snapshots'), request('/sandboxes'),
      ]);
      const limits = parseBoatValue(BoatLimitsResponseSchema, limitsValue);
      const snapshots = parseBoatValue(snapshotsResponse, snapshotsValue).snapshots
        .filter((value): value is typeof value & { status: 'ready' } => value.status === 'ready')
        .map(({ name, status }) => ({ name, status }));
      const sandboxes: BoatOptions['sandboxes'][number][] = [];
      let sandboxesValue = firstSandboxesValue;
      for (;;) {
        const response = parseBoatValue(sandboxesResponse, sandboxesValue);
        sandboxes.push(...response.sandboxes
          .filter(value => ['ready', 'idle', 'running', 'archived'].includes(value.state))
          .map(value => ({ id: value.id, ...(value.name ? { name: value.name } : {}), state: value.state })));
        if (!response.pageInfo?.hasMore) break;
        if (!response.pageInfo.nextCursor) throw new BoatNativeError('native_response_invalid');
        const query = new URLSearchParams({ cursor: response.pageInfo.nextCursor });
        sandboxesValue = await request(`/sandboxes?${query}`);
      }
      return { ...(limits.sandboxPlanKey ? { sandboxPlanKey: limits.sandboxPlanKey } : {}),
        sizes: limits.sandboxPlanDollars !== undefined && limits.sandboxPlanDollars >= 100 ? [...BASE_SIZES, XLARGE] : BASE_SIZES, snapshots, sandboxes };
    },
    async acquire(input: Readonly<{ launch: BoatLaunchV1; idempotencyKey: string }>): Promise<BoatAcquireResult> {
      const launch = BoatLaunchV1Schema.parse(input.launch);
      if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 255) return { kind: 'refused', code: 'invalid_request' };
      const ttlSeconds = await accountTtlSeconds();
      if (launch.source.kind === 'named-snapshot') {
        const source = launch.source;
        // SavedSnapshotListResponse replaces the deprecated named-snapshot list.
        // https://docs.boat.dev/openapi/boat-v1.yaml#/components/schemas/SavedSnapshotListResponse
        const listed = parseBoatValue(snapshotsResponse, await request('/saved-snapshots'));
        if (!listed.snapshots.some(value => value.name === source.name && value.status === 'ready')) {
          return { kind: 'refused', code: 'native_snapshot_not_ready', nativeCause: { localCause: 'native_options_changed' } };
        }
      }
      const selected = endpoint(launch, input.idempotencyKey, ttlSeconds);
      const operation = BoatAcquireOperationV1Schema.parse({
        kind: 'acquire', idempotencyKey: input.idempotencyKey,
      });
      try {
        const value = await request(selected.path, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operation.idempotencyKey },
          body: JSON.stringify(selected.body),
        });
        const accepted = parseBoatValue(createResponse, value);
        // Creation custody survives malformed or absent readiness facts.
        // Only exact-resource inspection can establish readiness afterwards.
        return { kind: 'bound', resource: { sandboxId: accepted.sandbox.id }, ready: false };
      } catch (error) {
        const cause = error instanceof BoatNativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {};
        if (error instanceof BoatNativeError && isBoatAdmissionRefusalCode(error.code)) {
          return { kind: 'refused', code: error.code, ...cause };
        }
        // A lost or undecodable reply cannot disprove the submitted effect.
        return { kind: 'pending', operation, ...cause };
      }
    },
    async reconcileAcquire(raw: BoatAcquireOperationV1): Promise<BoatAcquireResult> {
      const operation = BoatAcquireOperationV1Schema.parse(raw);
      if (operation.sandboxId) {
        const observed = await this.inspect({ sandboxId: operation.sandboxId });
        if (observed.kind === 'present' && observed.power === 'running') return { kind: 'bound', resource: { sandboxId: operation.sandboxId }, ready: true };
        if (observed.kind === 'failed') return { kind: 'refused', code: 'native_acquire_failed' };
        return observed.kind === 'pending' ? { kind: 'pending', operation }
          : { kind: 'unknown', code: 'native_resource_unavailable' };
      }
      // List-sandboxes label/cursor, https://docs.boat.dev/openapi/boat-v1.yaml.
      // This is read-only even after the idempotency window. No match cannot
      // disprove a submitted create; several matches cannot establish identity.
      const query = new URLSearchParams({ label: `happier-managed-id=${operation.idempotencyKey}` });
      let found: string | undefined;
      for (;;) {
        const response = parseBoatValue(recoveryResponse, await request(`/sandboxes?${query}`));
        for (const candidate of response.sandboxes) {
          if (found !== undefined && found !== candidate.id) return { kind: 'unknown', code: 'native_identity_ambiguous' };
          found = candidate.id;
        }
        if (!response.pageInfo?.hasMore) break;
        if (!response.pageInfo.nextCursor) throw new BoatNativeError('native_response_invalid');
        query.set('cursor', response.pageInfo.nextCursor);
      }
      return found ? { kind: 'bound', resource: { sandboxId: found }, ready: false }
        : { kind: 'unknown', code: 'native_identity_unavailable' };
    },
    async inspect(raw: BoatResourceV1) {
      const resource = BoatResourceV1Schema.parse(raw);
      try {
        const response = parseBoatValue(sandboxResponse, await request(`/sandboxes/${encodeURIComponent(resource.sandboxId)}`));
        if (response.sandbox.id !== resource.sandboxId) throw new BoatNativeError('native_identity_mismatch');
        const state = response.sandbox.state;
        const facts = {
          storage: response.sandbox.dataExpiredAt ? 'lost' as const
            : state === 'archived' && response.sandbox.dataExpiredAt === undefined ? 'unknown' as const : 'retained' as const,
          ...(response.sandbox.archiveAfter ? { nativeExpiry: Date.parse(response.sandbox.archiveAfter) } : {}),
          deletionNotices: state === 'archived' || state === 'archiving' ? [{ ...BOAT_STOPPED_STORAGE_NOTICE,
            ...(state === 'archived' && response.sandbox.stoppedAt
              ? { at: Date.parse(response.sandbox.stoppedAt) + BOAT_STOPPED_STORAGE_NOTICE.rule.afterMs } : {}),
          }] : [],
        };
        // Sandbox.health (same OpenAPI): a live but unreachable VM is not ready
        // for bootstrap or confirmed resume. Keep the existing observation reason.
        if (response.sandbox.health === 'degraded') return { kind: 'unknown' as const, power: 'unknown' as const,
          reason: 'native_resource_degraded', ...facts };
        if (['ready', 'idle', 'running'].includes(state)) return { kind: 'present' as const, power: 'running' as const, ...facts };
        if (state === 'archived') return { kind: 'present' as const, power: 'stopped' as const, ...facts };
        if (state === 'archiving') return { kind: 'present' as const, power: 'unknown' as const, ...facts };
        if (['init', 'provisioning', 'provisioned', 'cloning'].includes(state)) return { kind: 'pending' as const, power: 'unknown' as const,
          ...facts, storage: 'unknown' as const, reason: 'native_resource_creating' };
        if (['error', 'cancelled'].includes(state)) return { kind: 'failed' as const, power: 'unknown' as const };
        return { kind: 'unknown' as const, power: 'unknown' as const };
      } catch (error) {
        if (error instanceof BoatNativeError && error.code === 'native_not_found') return { kind: 'absent' as const, power: 'unknown' as const };
        throw error;
      }
    },
    async renew(raw: BoatResourceV1, deadlineAt?: number) {
      const resource = BoatResourceV1Schema.parse(raw);
      const path = `/sandboxes/${encodeURIComponent(resource.sandboxId)}`;
      const current = parseBoatValue(sandboxResponse, await request(path)).sandbox;
      if (current.id !== resource.sandboxId) throw new BoatNativeError('native_identity_mismatch');
      if (current.ttlSeconds === undefined) throw new BoatNativeError('native_response_invalid');
      if (current.ttlSeconds === null || current.state === 'archived' || current.state === 'archiving') return { kind: 'unnecessary' as const };
      if (!['ready', 'idle', 'running'].includes(current.state)) throw new BoatNativeError('native_not_ready');
      // Boat's documented integer TTL minimum is one second. The host supplies
      // its selected deadline; only the vendor's mandatory window is decided here.
      const ttlSeconds = deadlineAt === undefined ? TRIAL_TTL_SECONDS
        : Math.max(1, Math.min(TRIAL_TTL_SECONDS, Math.ceil((deadlineAt - Date.now()) / 1000)));
      const updated = parseBoatValue(sandboxResponse, await request(path, { method: 'PATCH',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttlSeconds }) })).sandbox;
      if (updated.id !== resource.sandboxId) throw new BoatNativeError('native_identity_mismatch');
      if (!updated.archiveAfter) throw new BoatNativeError('native_response_invalid');
      const nativeExpiry = Date.parse(updated.archiveAfter);
      const renewalLeadMs = ttlSeconds * 1000 / 2;
      return { kind: 'renewed' as const, nativeExpiry,
        ...(deadlineAt === undefined || nativeExpiry < deadlineAt
          ? { renewAt: nativeExpiry - renewalLeadMs } : {}) };
    },
    async bootstrap(raw: BoatResourceV1, publicKey: string) {
      const resource = BoatResourceV1Schema.parse(raw);
      const key = parseBoatValue(BoatPublicKeySchema, publicKey, 'native_ssh_key_invalid');
      const observed = await this.inspect(resource);
      if (observed.kind === 'pending') throw new BoatNativeError('native_not_ready');
      if (observed.kind !== 'present' || observed.power !== 'running') throw new BoatNativeError('native_resource_unavailable');
      const response = parseBoatValue(sshResponse, await request(`/sandboxes/${encodeURIComponent(resource.sandboxId)}/sshkey`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
      }));
      if (!response.machineIp || !response.hostKey || response.sshUser !== 'user') throw new BoatNativeError('native_ssh_evidence_invalid');
      let address = response.machineIp;
      let port = 22;
      if (response.sshEndpoint) {
        const separator = response.sshEndpoint.lastIndexOf(':');
        const candidatePort = Number(response.sshEndpoint.slice(separator + 1));
        if (separator <= 0 || !Number.isInteger(candidatePort) || candidatePort < 1 || candidatePort > 65535) throw new BoatNativeError('native_ssh_evidence_invalid');
        address = response.sshEndpoint.slice(0, separator);
        port = candidatePort;
      }
      return { address, port, username: 'user' as const, hostKey: response.hostKey };
    },
    async power(raw: BoatResourceV1, intent: 'stop' | 'resume' | 'start') {
      const resource = BoatResourceV1Schema.parse(raw);
      const nativeIntent = intent === 'start' ? 'resume' : intent;
      await request(`/sandboxes/${encodeURIComponent(resource.sandboxId)}/${nativeIntent}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        ...(nativeIntent === 'resume' ? { body: JSON.stringify({ ttlSeconds: await accountTtlSeconds() }) } : {}),
      });
      const observed = await this.inspect(resource);
      return observed.kind === 'present' && observed.power === (nativeIntent === 'stop' ? 'stopped' : 'running')
        ? { kind: 'confirmed' as const } : { kind: 'pending' as const };
    },
    async destroy(input: Readonly<{ resource: BoatResourceV1 }>) {
      const resource = BoatResourceV1Schema.parse(input.resource);
      const response = parseBoatValue(deletionResponse, await request(`/sandboxes/${encodeURIComponent(resource.sandboxId)}`, {
        method: 'DELETE', headers: { 'X-Ascii-Confirm-Delete': resource.sandboxId },
      }));
      if (response.operation.targetId !== resource.sandboxId) throw new BoatNativeError('native_identity_mismatch');
      return { kind: 'pending' as const, operation: BoatDeleteOperationV1Schema.parse({
        kind: 'delete', operationId: response.operation.id, sandboxId: resource.sandboxId,
      }) };
    },
    async reconcileDestroy(raw: BoatDeleteOperationV1) {
      const operation = BoatDeleteOperationV1Schema.parse(raw);
      const response = parseBoatValue(deletionResponse, await request(`/deletion-operations/${encodeURIComponent(operation.operationId)}`));
      if (response.operation.id !== operation.operationId || response.operation.targetId !== operation.sandboxId) throw new BoatNativeError('native_identity_mismatch');
      if (response.operation.status === 'completed') return { kind: 'confirmed' as const };
      if (response.operation.status === 'blocked') return { kind: 'failed' as const, code: 'native_delete_blocked' };
      return { kind: 'pending' as const };
    },
  };
}
