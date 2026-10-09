import * as z from 'zod/mini';
import { FLY_DEFAULT_IMAGE, FlyAcquireOperationV1Schema, FlyAcquireRequestSchema, FlyExecRequestSchema, FlyExecResponseSchema, FlyGuestBootSchema, FlyLaunchV1Schema, FlyMachineSchema, FlyProcessConfigurationSchema, FlyPutFileRequestSchema, FlyResourceV1Schema, FlyVolumeSchema, type FlyAcquireOperationV1, type FlyAcquireRequest, type FlyExecRequest, type FlyGuestBoot, type FlyLaunchV1, type FlyPutFileRequest, type FlyResourceV1 } from './schemas.js';

// REST v1; fly-go v0.9.4 characterizes identity/rootfs. The current official
// docs.machines.dev/machines/Machines_exec declares command argv and stdin
// (cmd is deprecated); no flyctl process or secret-bearing argv is used.
export const FLY_MACHINES_API = 'https://api.machines.dev/v1';
const FLY_GRAPHQL_API = 'https://api.fly.io/graphql';
// These fields are pinned to fly-go v0.9.4/schema.graphql. Native connection
// totalCount proves emptiness without a page-size guess or an empty first page.
const APP_INVENTORY_QUERY = `query HappierAppInventory($name: String!) {
  app(name: $name) { name certificates { totalCount } ipAddresses { totalCount }
    egressIpAddresses { totalCount } addOns { totalCount } secrets { name }
    services { protocol } allocations(showCompleted: false) { id } hasDeploymentSource }
}`;
const countSchema = z.object({ totalCount: z.int().check(z.gte(0)) });
const appInventorySchema = z.object({ data: z.object({ app: z.nullable(z.object({
  name: z.string(), certificates: countSchema, ipAddresses: countSchema,
  egressIpAddresses: countSchema, addOns: countSchema,
  secrets: z.array(z.object({ name: z.string() })), services: z.array(z.object({ protocol: z.string() })),
  allocations: z.array(z.object({ id: z.string() })), hasDeploymentSource: z.boolean(),
})) }), errors: z.optional(z.array(z.unknown())) });
const PLATFORM_QUERY = `query HappierMachineOptions { platform {
  regions { code name deprecated requiresPaidPlan }
  vmSizes { name cpuCores memoryMb maxMemoryMb memoryIncrementsMb priceMonth priceSecond }
} }`;
const platformSchema = z.object({ data: z.object({ platform: z.object({
  regions: z.array(z.object({ code: z.string(), name: z.string(), deprecated: z.boolean(), requiresPaidPlan: z.boolean() })),
  vmSizes: z.array(z.object({ name: z.string(), cpuCores: z.number(), memoryMb: z.int(), maxMemoryMb: z.int(),
    memoryIncrementsMb: z.array(z.int()), priceMonth: z.number(), priceSecond: z.number() })),
}) }), errors: z.optional(z.array(z.unknown())) });
const appsSchema = z.object({ total_apps: z.int().check(z.gte(0)), apps: z.array(z.object({
  id: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)), machine_count: z.int().check(z.gte(0)), volume_count: z.int().check(z.gte(0)),
})) });
const discoveryInputSchema = z.strictObject({ organizationSlug: z.string().check(z.trim(), z.minLength(1)), appName: z.optional(z.string().check(z.trim(), z.minLength(1))) });
type Failure = Readonly<{ kind: 'unavailable' | 'unknown' | 'refused'; reason: 'authorization' | 'transport' | 'native-refusal' | 'native-error' | 'invalid-response'; status?: number }>;
type HttpResult = Readonly<{ kind: 'ok'; value: unknown }> | Readonly<{ kind: 'absent' }> | Failure;
export type FlyInspection = Readonly<{
  kind: 'present'; machineId: string; instanceId?: string; state: string;
  storage: 'retained' | 'lost' | 'unknown'; memory: 'not-guaranteed';
  rootfsPersistence: string; rootfsAfterStop: 'reset' | 'unknown';
  volumeMountPath?: string;
  stoppedComputeBilling: 'not-billed'; autonomousPower: boolean;
}> | Readonly<{ kind: 'absent' }> | Failure;
export type FlyExecResult = Readonly<{ kind: 'completed'; exitCode: number; exitSignal?: number; stdout: string; stderr: string }> | Readonly<{ kind: 'absent' }> | Failure;
export type FlyCleanup = Readonly<{
  machine: 'absent' | 'unknown'; volume: 'absent' | 'retained' | 'unknown';
  app: 'absent' | 'retained' | 'unknown'; complete: boolean; reason?: string; retryable?: boolean;
}>;
export type FlyAcquireResult = Readonly<{ kind: 'bound'; resource: FlyResourceV1 }>
  | Readonly<{ kind: 'rejected'; reason: 'scope-mismatch' | 'launch-unavailable' | 'provider-unavailable' }>
  | Readonly<{ kind: 'unknown' | 'refused'; reason: string; operation: FlyAcquireOperationV1 }>;
export type FlyOptionsInput = z.infer<typeof discoveryInputSchema>;
export type FlyOptionsResult = Readonly<{ kind: 'available'; regions: z.infer<typeof platformSchema>['data']['platform']['regions'];
  sizes: z.infer<typeof platformSchema>['data']['platform']['vmSizes']; apps: z.infer<typeof appsSchema>['apps']; volumes: z.infer<typeof FlyVolumeSchema>[]; prices: readonly [] }> | Failure;

const invalid = (): Failure => ({ kind: 'unavailable', reason: 'invalid-response' });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function createFlyNativeClient(token: string, request: typeof fetch = fetch, context: Readonly<{ signal?: AbortSignal; organizationSlug?: string }> = {}) {
  async function requestJson(url: string, method = 'GET', body?: unknown): Promise<HttpResult> {
    let response: Response;
    if (context.signal?.aborted) return { kind: method === 'GET' ? 'unavailable' : 'unknown', reason: 'transport' };
    try {
      response = await request(url, {
        method, redirect: 'error', ...(context.signal ? { signal: context.signal } : {}),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { return { kind: method === 'GET' ? 'unavailable' : 'unknown', reason: 'transport' }; }
    if (response.status === 404) return { kind: 'absent' };
    if (response.status === 401 || response.status === 403) return { kind: 'unavailable', reason: 'authorization', status: response.status };
    // Reflected native bodies may contain credentials or private input. They
    // never enter public errors, diagnostics or recovery state.
    if (!response.ok) return { kind: method === 'GET' ? 'unavailable' : response.status < 500 ? 'refused' : 'unknown', reason: response.status < 500 ? 'native-refusal' : 'native-error', status: response.status };
    const text = await response.text().catch(() => null);
    if (text === null) return { kind: method === 'GET' ? 'unavailable' : 'unknown', reason: 'transport' };
    if (!text) return { kind: 'ok', value: null };
    try { return { kind: 'ok', value: JSON.parse(text) as unknown }; }
    catch { return { kind: method === 'GET' ? 'unavailable' : 'unknown', reason: 'invalid-response' }; }
  }
  const http = (path: string, method = 'GET', body?: unknown) => requestJson(`${FLY_MACHINES_API}${path}`, method, body);
  const appPath = (name: string) => `/apps/${encodeURIComponent(name)}`;
  const machinePath = (resource: FlyResourceV1) => `${appPath(resource.app.name)}/machines/${encodeURIComponent(resource.machineId)}`;
  const volumePath = (resource: FlyResourceV1) => `${appPath(resource.app.name)}/volumes/${encodeURIComponent(resource.volume.id)}`;

  async function listApps(organizationSlug: string) {
    const result = await http(`/apps?${new URLSearchParams({ org_slug: organizationSlug }).toString()}`);
    if (result.kind !== 'ok') return result.kind === 'absent' ? invalid() : result;
    const parsed = appsSchema.safeParse(result.value);
    if (!parsed.success || parsed.data.total_apps !== parsed.data.apps.length) return invalid();
    return { kind: 'available' as const, apps: parsed.data.apps };
  }

  async function check(input: Pick<FlyOptionsInput, 'organizationSlug'>) {
    const { organizationSlug } = discoveryInputSchema.parse(input);
    const result = await listApps(organizationSlug);
    return result.kind === 'available' ? { available: true as const } : { available: false as const, code: result.reason };
  }

  async function options(input: FlyOptionsInput): Promise<FlyOptionsResult> {
    const { organizationSlug, appName } = discoveryInputSchema.parse(input);
    const platform = await requestJson(FLY_GRAPHQL_API, 'POST', { query: PLATFORM_QUERY });
    if (platform.kind !== 'ok') return platform.kind === 'absent' ? invalid() : platform;
    const parsed = platformSchema.safeParse(platform.value);
    if (!parsed.success || parsed.data.errors?.length) return invalid();
    const apps = await listApps(organizationSlug);
    if (apps.kind !== 'available') return apps;
    let volumes: z.infer<typeof FlyVolumeSchema>[] = [];
    if (appName) {
      if (!apps.apps.some(app => app.name === appName)) return { kind: 'refused', reason: 'native-refusal' };
      const native = await http(`${appPath(appName)}/volumes`);
      if (native.kind !== 'ok') return native.kind === 'absent' ? invalid() : native;
      const decoded = z.array(FlyVolumeSchema).safeParse(native.value);
      if (!decoded.success) return invalid();
      volumes = decoded.data;
    }
    // Native GraphQL rates expose their units but no currency. Preserve the
    // actual facts without inventing a currency or normalized price receipt.
    return { kind: 'available', regions: parsed.data.data.platform.regions, sizes: parsed.data.data.platform.vmSizes, apps: apps.apps, volumes, prices: [] };
  }

  async function acquire(input: FlyAcquireRequest): Promise<FlyAcquireResult> {
    const { launch, requestId, boot } = FlyAcquireRequestSchema.parse(input);
    if (!context.organizationSlug || launch.app.organizationSlug !== undefined && launch.app.organizationSlug !== context.organizationSlug) {
      return { kind: 'rejected', reason: 'scope-mismatch' };
    }
    const current = await options({ organizationSlug: context.organizationSlug,
      ...(launch.app.ownership === 'existing' ? { appName: launch.app.name } : {}) });
    if (current.kind !== 'available') return { kind: 'rejected', reason: current.kind === 'refused' ? 'launch-unavailable' : 'provider-unavailable' };
    if (!isLaunchAvailable(launch, current, context.organizationSlug)) return { kind: 'rejected', reason: 'launch-unavailable' };
    let operation: FlyAcquireOperationV1 = {
      app: { name: launch.app.name, ownership: launch.app.ownership === 'created' ? 'unknown' : 'existing' },
      requestId, phase: launch.app.ownership === 'created' ? 'app' : 'volume',
    };
    const failed = (result: HttpResult): FlyAcquireResult => ({ kind: result.kind === 'refused' || result.kind === 'absent' ? 'refused' : 'unknown', reason: result.kind === 'absent' ? 'native-absent' : result.kind === 'ok' ? 'invalid-response' : result.reason, operation });
    // Every successful stage's exact ids are returned even when a later stage
    // is ambiguous. The host retains this native operation value on its row;
    // this leaf has no private acquisition ledger or retry loop.
    if (launch.app.ownership === 'created') {
      const created = await http('/apps', 'POST', { app_name: launch.app.name, org_slug: context.organizationSlug });
      if (created.kind !== 'ok') return failed(created);
      const parsed = z.object({ id: z.string().check(z.minLength(1)) }).safeParse(created.value);
      if (!parsed.success) return failed({ kind: 'unknown', reason: 'invalid-response' });
      operation = { ...operation, app: { name: launch.app.name, id: parsed.data.id, ownership: 'created' }, phase: 'volume' };
    }
    const volume = launch.volume.kind === 'create'
      ? await http(`${appPath(launch.app.name)}/volumes`, 'POST', { name: 'happier', region: launch.region, size_gb: launch.volume.sizeGb, encrypted: true })
      : { kind: 'ok' as const, value: current.volumes.find(volume => launch.volume.kind === 'attach' && volume.id === launch.volume.volumeId) };
    if (volume.kind !== 'ok') return failed(volume);
    if (launch.volume.kind === 'create') {
      const identity = z.object({ id: z.string().check(z.minLength(1)) }).safeParse(volume.value);
      if (!identity.success) return failed({ kind: 'unknown', reason: 'invalid-response' });
      operation = { ...operation, volume: { id: identity.data.id, ownership: 'created' } };
    }
    const parsed = FlyVolumeSchema.safeParse(volume.value);
    if (!parsed.success || (launch.volume.kind === 'attach' && parsed.data.id !== launch.volume.volumeId)) return failed({ kind: 'unknown', reason: 'invalid-response' });
    const selectedVolume = { id: parsed.data.id, ownership: launch.volume.kind === 'create' ? 'created' as const : 'attached' as const };
    // Record a successfully created volume before refusing any native placement
    // mismatch: cleanup must still see the actual paid attachment.
    if (launch.volume.kind === 'create') operation = { ...operation, volume: selectedVolume };
    if (parsed.data.state !== 'created' || parsed.data.region !== launch.region || parsed.data.attached_machine_id !== null) return { kind: 'refused', reason: 'volume-unavailable', operation };
    operation = { ...operation, volume: selectedVolume, phase: 'machine' };
    const machine = await http(`${appPath(launch.app.name)}/machines`, 'POST', {
      region: launch.region,
      config: {
        image: launch.imageReference ?? FLY_DEFAULT_IMAGE,
        guest: { cpu_kind: launch.guest.cpuKind, cpus: launch.guest.cpus, memory_mb: launch.guest.memoryMb },
        mounts: [{ volume: parsed.data.id, path: boot.homeDir }],
        env: { HOME: boot.homeDir, HAPPIER_HOME_DIR: boot.happyHomeDir }, init: { exec: boot.command },
        rootfs: { persist: 'never' }, services: [], restart: { policy: 'no' }, auto_destroy: false,
        metadata: { 'happier.request': requestId },
      },
    });
    if (machine.kind !== 'ok') return failed(machine);
    // A paid resource's native identity is independent of readiness/config.
    // Retain it immediately; inspect can truthfully report invalid observation.
    const native = z.object({ id: z.string().check(z.minLength(1)) }).safeParse(machine.value);
    if (!native.success) return failed({ kind: 'unknown', reason: 'invalid-response' });
    return { kind: 'bound', resource: { app: { name: operation.app.name, ownership: launch.app.ownership, ...(operation.app.id ? { id: operation.app.id } : {}) }, machineId: native.data.id, volume: selectedVolume } };
  }

  async function recover(input: FlyAcquireOperationV1, inputLaunch: FlyLaunchV1, inputBoot: FlyGuestBoot): Promise<FlyAcquireResult> {
    const operation = FlyAcquireOperationV1Schema.parse(input);
    const launch = FlyLaunchV1Schema.parse(inputLaunch);
    const boot = FlyGuestBootSchema.parse(inputBoot);
    if (operation.app.name !== launch.app.name || operation.app.ownership === 'unknown' || !operation.volume || operation.phase !== 'machine') return { kind: 'unknown', reason: 'unqualified-recovery', operation };
    const params = new URLSearchParams({ 'metadata.happier.request': operation.requestId });
    const listed = await http(`${appPath(operation.app.name)}/machines?${params.toString()}`);
    if (listed.kind !== 'ok') return { kind: 'unknown', reason: listed.kind === 'absent' ? 'native-absent' : listed.reason, operation };
    const parsed = z.array(FlyMachineSchema).safeParse(listed.value);
    if (!parsed.success) return { kind: 'unknown', reason: 'invalid-response', operation };
    const candidates = parsed.data.filter(machine => machine.state !== 'destroyed'
      && machine.region === launch.region
      && machine.config.image === (launch.imageReference ?? FLY_DEFAULT_IMAGE)
      && machine.config.metadata?.['happier.request'] === operation.requestId
      && machine.config.guest?.cpu_kind === launch.guest.cpuKind
      && machine.config.guest.cpus === launch.guest.cpus
      && machine.config.guest.memory_mb === launch.guest.memoryMb
      && machine.config.mounts.some(mount => mount.volume === operation.volume?.id && mount.path === boot.homeDir));
    if (candidates.length !== 1) return { kind: 'unknown', reason: candidates.length > 1 ? 'ambiguous-recovery' : 'unqualified-recovery', operation };
    return { kind: 'bound', resource: { app: { name: operation.app.name, ownership: operation.app.ownership, ...(operation.app.id ? { id: operation.app.id } : {}) }, machineId: candidates[0].id, volume: operation.volume } };
  }

  async function inspect(input: FlyResourceV1): Promise<FlyInspection> {
    const resource = FlyResourceV1Schema.parse(input);
    const result = await http(machinePath(resource));
    if (result.kind !== 'ok') return result;
    const machine = FlyMachineSchema.safeParse(result.value);
    if (!machine.success || machine.data.id !== resource.machineId) return invalid();
    if (machine.data.state === 'destroyed') return { kind: 'absent' };
    const volume = await http(volumePath(resource));
    let storage: 'retained' | 'lost' | 'unknown' = 'unknown';
    if (volume.kind === 'absent') storage = 'lost';
    if (volume.kind === 'ok') {
      const parsed = FlyVolumeSchema.safeParse(volume.value);
      if (parsed.success && parsed.data.id === resource.volume.id) {
        storage = parsed.data.state === 'destroyed' ? 'lost'
          : machine.data.config.mounts.some(mount => mount.volume === resource.volume.id)
            && parsed.data.attached_machine_id === resource.machineId ? 'retained' : 'unknown';
      }
    }
    const rootfsPersistence = machine.data.config.rootfs?.persist || 'never';
    const volumeMountPath = machine.data.config.mounts.find(mount => mount.volume === resource.volume.id)?.path;
    return {
      kind: 'present', machineId: machine.data.id, ...(machine.data.instance_id ? { instanceId: machine.data.instance_id } : {}),
      state: machine.data.state, storage, memory: 'not-guaranteed', rootfsPersistence,
      ...(volumeMountPath ? { volumeMountPath } : {}),
      rootfsAfterStop: rootfsPersistence === 'never' || rootfsPersistence === 'none' ? 'reset' : 'unknown',
      stoppedComputeBilling: 'not-billed',
      autonomousPower: machine.data.config.services.some(service => service.autostart === true || service.autostop === true || service.autostop === 'stop' || service.autostop === 'suspend'),
    };
  }

  async function power(input: FlyResourceV1, operation: 'start' | 'resume' | 'stop' | 'suspend'): Promise<FlyInspection> {
    const resource = FlyResourceV1Schema.parse(input);
    if (!['start', 'resume', 'stop', 'suspend'].includes(operation)) return { kind: 'refused', reason: 'native-refusal' };
    const result = await http(`${machinePath(resource)}/${operation === 'resume' ? 'start' : operation}`, 'POST', {});
    if (result.kind !== 'ok') return result;
    return inspect(resource);
  }

  async function exec(input: FlyResourceV1, inputRequest: FlyExecRequest): Promise<FlyExecResult> {
    const resource = FlyResourceV1Schema.parse(input);
    const args = FlyExecRequestSchema.parse(inputRequest);
    const result = await http(`${machinePath(resource)}/exec`, 'POST', args);
    if (result.kind !== 'ok') return result;
    const parsed = FlyExecResponseSchema.safeParse(result.value);
    if (!parsed.success) return { kind: 'unknown', reason: 'invalid-response' };
    return { kind: 'completed', exitCode: parsed.data.exit_code, ...(parsed.data.exit_signal === undefined ? {} : { exitSignal: parsed.data.exit_signal }), stdout: parsed.data.stdout, stderr: parsed.data.stderr };
  }

  async function putFile(resource: FlyResourceV1, inputRequest: FlyPutFileRequest) {
    const args = FlyPutFileRequestSchema.parse(inputRequest);
    // Only the path/mode enter argv. Payload stays in the authenticated exec
    // request's private stdin, including for quotes/newlines in the guest path.
    const result = await exec(resource, {
      command: ['/bin/sh', '-c', `umask 077; touch ${quote(args.guestPath)} && chmod 600 ${quote(args.guestPath)} && base64 -d > ${quote(args.guestPath)} && chmod ${args.mode.toString(8)} ${quote(args.guestPath)}`],
      stdin: args.bytesBase64, ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
    });
    if (result.kind !== 'completed') return result;
    return result.exitCode === 0 && !result.exitSignal ? { kind: 'written' as const }
      : { kind: 'refused' as const, reason: 'native-exit' as const, exitCode: result.exitCode, ...(result.exitSignal === undefined ? {} : { exitSignal: result.exitSignal }) };
  }

  /** REST v1 update reboots a running Machine. Configured is not daemon-online
   * evidence: ordinary enrollment and connectivity remain host-owned. */
  async function configureProcess(input: FlyResourceV1, request: z.infer<typeof FlyProcessConfigurationSchema>) {
    const resource = FlyResourceV1Schema.parse(input);
    const process = FlyProcessConfigurationSchema.parse(request);
    const observed = await http(machinePath(resource));
    if (observed.kind !== 'ok') return observed;
    const machine = FlyMachineSchema.safeParse(observed.value);
    if (!machine.success || machine.data.id !== resource.machineId) return invalid();
    if (!machine.data.config.mounts.some(mount => mount.volume === resource.volume.id && mount.path === process.environment.HOME)) {
      return { kind: 'refused' as const, reason: 'native-refusal' as const };
    }
    const config = { ...machine.data.config, env: { ...machine.data.config.env, ...process.environment }, init: { ...machine.data.config.init, exec: process.command } };
    const updated = await http(machinePath(resource), 'POST', { config });
    if (updated.kind !== 'ok') return updated;
    const decoded = FlyMachineSchema.safeParse(updated.value);
    if (!decoded.success || decoded.data.id !== resource.machineId
      || JSON.stringify(decoded.data.config.init?.exec) !== JSON.stringify(process.command)
      || !decoded.data.config.mounts.some(mount => mount.volume === resource.volume.id && mount.path === process.environment.HOME)
      || Object.entries(process.environment).some(([key, value]) => decoded.data.config.env?.[key] !== value)) {
      return { kind: 'unknown' as const, reason: 'invalid-response' as const };
    }
    return { kind: 'configured' as const };
  }

  async function destroyAttachments(resource: Readonly<{ app: FlyResourceV1['app']; volume?: FlyResourceV1['volume']; machineId?: string }>, observeOnly = false): Promise<FlyCleanup> {
    const cleanup: { machine: FlyCleanup['machine']; volume: FlyCleanup['volume']; app: FlyCleanup['app']; complete: boolean; reason?: string } = {
      machine: 'absent', volume: !resource.volume ? 'absent' : resource.volume.ownership === 'attached' ? 'retained' : 'unknown',
      app: resource.app.ownership === 'existing' ? 'retained' : 'unknown', complete: false,
    };
    let ownedVolumePresent = false;
    if (resource.volume?.ownership === 'created') {
      const path = `${appPath(resource.app.name)}/volumes/${encodeURIComponent(resource.volume.id)}`;
      const observed = await http(path);
      if (observed.kind === 'absent') cleanup.volume = 'absent';
      else if (observed.kind === 'ok') {
        const volume = FlyVolumeSchema.safeParse(observed.value);
        if (!volume.success || volume.data.id !== resource.volume.id) return { ...cleanup, reason: 'volume-observation-unavailable' };
        if (volume.data.state === 'destroyed') cleanup.volume = 'absent';
        else if (volume.data.attached_machine_id !== null
          && (!resource.machineId || volume.data.attached_machine_id !== resource.machineId)) return { ...cleanup, volume: 'retained', reason: 'volume-attachment-unavailable' };
        else {
          if (observeOnly) {
            // Machines REST v1 Volume_delete addresses the immutable volume id.
            // Identical DELETE is idempotent (RFC 9110 §9.2.2); only this freshly
            // observed unattached owned volume is qualified. An owned app must
            // also pass the incumbent complete-inventory/identity predicate.
            if (resource.app.ownership === 'existing') return { ...cleanup, reason: 'volume-deletion-unconfirmed', retryable: true };
            ownedVolumePresent = true;
          } else {
            const deleted = await http(path, 'DELETE');
            if (deleted.kind !== 'ok' && deleted.kind !== 'absent') return { ...cleanup, reason: deleted.reason };
            const confirmation = await http(path);
            const parsed = confirmation.kind === 'ok' ? FlyVolumeSchema.safeParse(confirmation.value) : undefined;
            if (confirmation.kind === 'absent' || (parsed?.success && parsed.data.id === resource.volume.id && parsed.data.state === 'destroyed')) cleanup.volume = 'absent';
            else return { ...cleanup, reason: 'volume-deletion-unconfirmed' };
          }
        }
      } else return { ...cleanup, reason: 'volume-observation-unavailable' };
    }
    if (resource.app.ownership === 'created') {
      const observedIdentity = observeOnly ? await http(appPath(resource.app.name)) : undefined;
      if (observedIdentity?.kind === 'absent') return ownedVolumePresent ? { ...cleanup, reason: 'volume-deletion-unconfirmed' }
        : { ...cleanup, app: 'absent', complete: true };
      const machines = await http(`${appPath(resource.app.name)}/machines`);
      const volumes = await http(`${appPath(resource.app.name)}/volumes`);
      const machineList = machines.kind === 'ok' ? z.array(FlyMachineSchema).safeParse(machines.value) : undefined;
      const volumeList = volumes.kind === 'ok' ? z.array(FlyVolumeSchema).safeParse(volumes.value) : undefined;
      if (machines.kind === 'absent' && volumes.kind === 'absent') {
        if (ownedVolumePresent) return { ...cleanup, reason: 'volume-deletion-unconfirmed' };
        if (observeOnly) return { ...cleanup, reason: 'app-inventory-unavailable' };
        cleanup.app = 'absent';
      }
      else if (!machineList?.success || !volumeList?.success) return { ...cleanup, app: 'retained', reason: 'app-inventory-unavailable' };
      else if (machineList.data.some(value => value.state !== 'destroyed') || volumeList.data.some(value => value.state !== 'destroyed'
        && !(observeOnly && ownedVolumePresent && value.id === resource.volume?.id && value.attached_machine_id === null))) return { ...cleanup, app: 'retained', reason: 'app-not-empty' };
      else {
        const identity = observedIdentity ?? await http(appPath(resource.app.name));
        const parsedIdentity = identity.kind === 'ok' ? z.object({ id: z.string(), name: z.string() }).safeParse(identity.value) : undefined;
        if (identity.kind === 'absent') return ownedVolumePresent ? { ...cleanup, reason: 'volume-deletion-unconfirmed' }
          : { ...cleanup, app: 'absent', complete: true };
        if (!parsedIdentity?.success || !resource.app.id || parsedIdentity.data.id !== resource.app.id || parsedIdentity.data.name !== resource.app.name) return { ...cleanup, app: 'retained', reason: parsedIdentity?.success ? 'app-identity-unavailable' : 'app-inventory-unavailable' };
        const inventory = await requestJson(FLY_GRAPHQL_API, 'POST', { query: APP_INVENTORY_QUERY, variables: { name: resource.app.name } });
        const parsedInventory = inventory.kind === 'ok' ? appInventorySchema.safeParse(inventory.value) : undefined;
        if (!parsedInventory?.success || parsedInventory.data.errors?.length || !parsedInventory.data.data.app || parsedInventory.data.data.app.name !== resource.app.name) return { ...cleanup, app: 'retained', reason: 'app-inventory-unavailable' };
        const app = parsedInventory.data.data.app;
        if (app.certificates.totalCount || app.ipAddresses.totalCount || app.egressIpAddresses.totalCount || app.addOns.totalCount || app.secrets.length || app.services.length || app.allocations.length || app.hasDeploymentSource) return { ...cleanup, app: 'retained', reason: 'app-not-empty' };
        if (observeOnly) return { ...cleanup, app: 'retained', reason: 'app-deletion-unconfirmed', retryable: true };
        const deleted = await http(appPath(resource.app.name), 'DELETE');
        if (deleted.kind !== 'ok' && deleted.kind !== 'absent') return { ...cleanup, app: 'retained', reason: 'app-deletion-unconfirmed' };
        const confirmed = await http(appPath(resource.app.name));
        if (confirmed.kind === 'absent') cleanup.app = 'absent';
        else return { ...cleanup, app: 'retained', reason: 'app-deletion-unconfirmed' };
      }
    }
    return { ...cleanup, complete: true };
  }
  async function destroy(input: FlyResourceV1): Promise<FlyCleanup> {
    const resource = FlyResourceV1Schema.parse(input);
    const unknown: FlyCleanup = { machine: 'unknown', volume: resource.volume.ownership === 'attached' ? 'retained' : 'unknown',
      app: resource.app.ownership === 'existing' ? 'retained' : 'unknown', complete: false };
    const deletion = await http(machinePath(resource), 'DELETE');
    if (deletion.kind !== 'ok' && deletion.kind !== 'absent') return { ...unknown, reason: deletion.reason };
    const machine = await http(machinePath(resource));
    const observed = machine.kind === 'ok' ? FlyMachineSchema.safeParse(machine.value) : undefined;
    if (machine.kind !== 'absent' && !(observed?.success && observed.data.id === resource.machineId && observed.data.state === 'destroyed')) {
      return { ...unknown, reason: 'machine-deletion-unconfirmed' };
    }
    return destroyAttachments(resource);
  }
  async function destroyPending(input: FlyAcquireOperationV1, observeOnly = false): Promise<FlyCleanup> {
    const operation = FlyAcquireOperationV1Schema.parse(input);
    const unknown: FlyCleanup = { machine: operation.phase === 'machine' ? 'unknown' : 'absent',
      volume: !operation.volume ? 'absent' : operation.volume.ownership === 'attached' ? 'retained' : 'unknown',
      app: operation.app.ownership === 'existing' ? 'retained' : 'unknown', complete: false };
    if (operation.app.ownership === 'unknown') return { ...unknown, reason: 'app-ownership-unknown' };
    const app: FlyResourceV1['app'] = { ...operation.app, ownership: operation.app.ownership };
    if (operation.phase === 'machine') {
      if (!operation.volume) return { ...unknown, reason: 'unqualified-recovery' };
      const params = new URLSearchParams({ 'metadata.happier.request': operation.requestId });
      const listed = await http(`${appPath(operation.app.name)}/machines?${params.toString()}`);
      const parsed = listed.kind === 'ok' ? z.array(FlyMachineSchema).safeParse(listed.value) : undefined;
      if (!parsed?.success) return observeOnly && listed.kind === 'absent'
        ? destroyAttachments({ app, volume: operation.volume }, true)
        : { ...unknown, reason: 'machine-observation-unavailable' };
      const candidates = parsed.data.filter(machine => machine.state !== 'destroyed'
        && (machine.config.metadata?.['happier.request'] === operation.requestId
          || machine.config.mounts.some(mount => mount.volume === operation.volume?.id)));
      if (candidates.length) {
        if (candidates.length !== 1 || candidates[0].config.metadata?.['happier.request'] !== operation.requestId
          || !candidates[0].config.mounts.some(mount => mount.volume === operation.volume?.id)) return { ...unknown, reason: 'unqualified-recovery' };
        if (observeOnly) return { ...unknown, reason: 'machine-deletion-unconfirmed' };
        return destroy({ app, machineId: candidates[0].id, volume: operation.volume });
      }
    }
    return destroyAttachments({ app, ...(operation.volume ? { volume: operation.volume } : {}) }, observeOnly);
  }
  async function inspectPendingCleanup(input: FlyAcquireOperationV1): Promise<FlyCleanup> {
    const cleanup = await destroyPending(input, true);
    // An uncertain Machine creation is not an attachment-only continuation.
    return input.phase === 'machine' && cleanup.retryable ? { ...cleanup, retryable: false, reason: 'machine-observation-unavailable' } : cleanup;
  }
  return { check, options, acquire, recover, inspect, power, exec, putFile, configureProcess, destroy, destroyPending, inspectPendingCleanup };
}

/** Current native catalog and scope admission, shared by review and acquisition. */
export function isLaunchAvailable(launch: FlyLaunchV1, facts: Extract<FlyOptionsResult, { kind: 'available' }>, organizationSlug: string) {
  if (launch.app.organizationSlug !== undefined && launch.app.organizationSlug !== organizationSlug) return false;
  if (!facts.regions.some(region => region.code === launch.region && !region.deprecated)) return false;
  // fly-go v0.9.4 MachineGuest.ToSize defines these native catalog names.
  // docs.fly.io/machines/guides-examples/machine-sizing qualifies memory as
  // multiples of 256 MB (shared) or 2048 MB (performance); range is current API.
  const sizeName = launch.guest.cpuKind === 'shared' ? `shared-cpu-${launch.guest.cpus}x` : `performance-${launch.guest.cpus}x`;
  const size = facts.sizes.find(value => value.name === sizeName && value.cpuCores === launch.guest.cpus);
  if (!size || launch.guest.memoryMb < size.memoryMb || launch.guest.memoryMb > size.maxMemoryMb
    || launch.guest.memoryMb % (launch.guest.cpuKind === 'shared' ? 256 : 2048) !== 0) return false;
  const app = facts.apps.find(value => value.name === launch.app.name);
  if (launch.app.ownership === 'created' ? app !== undefined : app === undefined) return false;
  if (launch.volume.kind === 'attach') {
    if (launch.app.ownership !== 'existing') return false;
    const volumeId = launch.volume.volumeId;
    if (!facts.volumes.some(volume => volume.id === volumeId && volume.region === launch.region && volume.state === 'created' && volume.attached_machine_id === null)) return false;
  }
  return true;
}
