import axios from '@/api/client/credentialAxios';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { z } from 'zod/mini';
import { ExternalActionMachineBootstrapV1Schema, type ExternalActionMachineBootstrapV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { AccessibleMachineAccessV1Schema, type AccessibleMachineAccessV1, type MachineAvailabilityDiagnosticV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { resolveMachineSpawnReadinessV1 } from '@happier-dev/protocol/machines/machineSpawnReadinessV1';
import { DevcontainerChildProjectionV1Schema, type DevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { isMachineReachableV1, type MachinePresenceV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { StoredMachinePublishedMetadataV1Schema, type MachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { readMachineName, resolveMachineDisplayNameParts, type MachineNameMetadata } from '@happier-dev/protocol/machines/machineDisplayNames';
import { ManagedMachineInputRuntimeV1Schema, type ManagedMachineInputRuntimeV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { StoredCredentials } from '@/persistence';
import { resolvePublishedMachineContentCodec } from './machineDataEncryptionKey';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

// The machine bootstrap rows reuse the one Protocol-owned external Action
// bootstrap projection; this parser adds the legacy/full-account presence and
// `metadata` facts its consumers need. Labels and decoded platform facts remain
// CLI projections of that metadata and never alter machine identity.
const ACCOUNT_MACHINE_ROW_SCHEMA = z.looseObject({ ...ExternalActionMachineBootstrapV1Schema.shape,
    managedInputRuntime: z.optional(z.nullable(ManagedMachineInputRuntimeV1Schema)),
    deploymentApp: MachinePublishedRowV1Schema.shape.deploymentApp,
    metadata: z.optional(MachinePublishedRowV1Schema.shape.metadata), activeAt: z.optional(z.nullable(z.number())), access: z.optional(AccessibleMachineAccessV1Schema),
    presenceProtocolVersion: MachinePublishedRowV1Schema.shape.presenceProtocolVersion,
    devcontainerChild: z.optional(z.nullable(DevcontainerChildProjectionV1Schema)) });

const ACCOUNT_MACHINE_INVENTORY_SCHEMA = z.array(ACCOUNT_MACHINE_ROW_SCHEMA);

export type CurrentAccountMachineTarget = Readonly<{
  machineId: string;
  machineLabel: string;
}>;
export type CurrentAccountMachineInventoryItem = Readonly<{
  id: string; label: string; kind: 'persistent' | 'ephemeral_session_runner';
  managedMachineRef: ExternalActionMachineBootstrapV1['managedMachineRef'];
  managedInputRuntime?: ManagedMachineInputRuntimeV1 | null;
  installationId: string | null;
  active: boolean; revokedAt: number | null; replacedByMachineId: string | null;
  activeAt?: number | null;
  presenceProtocolVersion?: MachinePresenceV1['presenceProtocolVersion'];
  platform?: string;
  homeDir?: string;
  arch?: string;
  agentInventory?: MachinePublishedMetadataV1['agentInventory'];
  access?: AccessibleMachineAccessV1;
  sharedWithTeamScope?: ExternalActionMachineBootstrapV1['sharedWithTeamScope'];
  operationProtocolCapabilities?: unknown;
  operationProtocolCapabilitiesRevision?: unknown;
  devcontainerChild?: DevcontainerChildProjectionV1;
  deploymentApp?: z.infer<typeof ACCOUNT_MACHINE_ROW_SCHEMA>['deploymentApp'];
}>;

export type CurrentAccountMachineTargetResolution =
  | Readonly<{ kind: 'selected'; target: CurrentAccountMachineTarget }>
  | Readonly<{ kind: 'selection_required'; candidates: readonly CurrentAccountMachineTarget[] }>
  | Readonly<{ kind: 'unavailable'; code: string; message: string; details?: Readonly<{ machineIds: readonly string[] }> }>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMachineNameMetadata(metadata: string | null | undefined): MachineNameMetadata | null {
  if (!metadata) return null;
  try {
    const value: unknown = JSON.parse(metadata);
    if (!value || typeof value !== 'object') return null;
    const record = value as Readonly<Record<string, unknown>>;
    return { displayName: nonEmptyString(record.displayName), host: nonEmptyString(record.host) };
  } catch {
    return null;
  }
}

function unavailable(code: string, message: string): CurrentAccountMachineTargetResolution {
  return { kind: 'unavailable', code, message };
}

export async function listCurrentAccountMachines(params: Readonly<{
  token?: string;
  credentials?: StoredCredentials;
  authorization?: ExternalActionExecutionAuthorizationV1;
  effectActionId?: string;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
  /** Host selection consumes identity, current access and presence, never private metadata. */
  projection?: 'hostFacts';
  machineIds?: readonly string[];
  sharedWithTeamId?: string;
}>): Promise<readonly CurrentAccountMachineInventoryItem[]> {
  params.signal?.throwIfAborted();
  try {
    const serverHttpBaseUrl = params.serverHttpBaseUrl
      ? normalizeServerHttpBaseUrl(params.serverHttpBaseUrl)
      : params.authorization?.requesterHttpProjection?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
    const projection = params.authorization?.requesterHttpProjection;
    if (params.authorization && (!projection || projection.accountId !== params.authorization.binding.accountId
      || normalizeServerHttpBaseUrl(projection.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(serverHttpBaseUrl)
      || !await projection.isCurrent())) throw new Error('Requester Machine inventory authority is unavailable');
    if (!params.authorization && !params.token) throw new Error('Machine inventory authentication is unavailable');
    const demandedIds = params.machineIds === undefined ? undefined : new Set(params.machineIds);
    if (!params.authorization && demandedIds?.size === 0) return [];
    // A selected host uses the exact read under its incumbent credential;
    // requester projections retain the admitted root and reviewed child proof.
    const exactId = (params.credentials || params.authorization) && demandedIds?.size === 1 ? [...demandedIds][0] : undefined;
    const path = exactId === undefined ? '/v1/machines' : `/v1/machines/${encodeURIComponent(exactId)}`;
    const headers = projection ? await projection.createRequestHeaders({
      effectActionId: params.effectActionId ?? params.authorization!.binding.actionId, method: 'GET', path,
      ...(params.signal ? { signal: params.signal } : {}),
    }) : { Authorization: `Bearer ${params.token}` };
    if (!headers) throw new Error('Requester Machine inventory authority is unavailable');
    const config = {
      ...(params.sharedWithTeamId ? { params: { sharedWithTeamId: params.sharedWithTeamId } } : {}),
      headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers,
        ...(params.projection === 'hostFacts' ? { Accept: 'application/json;happier-machine-projection=host-facts' } : {}) },
      timeout: 20_000,
      ...(exactId === undefined ? {} : { validateStatus: acceptsCurrentAccountMachinePublicationStatus }),
      ...(params.signal ? { signal: params.signal } : {}),
    };
    const batch = !params.authorization && demandedIds !== undefined && exactId === undefined;
    const response = batch
      ? await axios.post<unknown>(`${serverHttpBaseUrl}/v1/machines/read-batch`,
        MachineReadBatchRequestV1Schema.parse({ machineIds: [...demandedIds] }), config)
      : await axios.get<unknown>(`${serverHttpBaseUrl}${path}`, config);
    params.signal?.throwIfAborted();
    if (projection && !await projection.isCurrent()) throw new Error('Requester Machine inventory authority retired');
    const data = batch ? MachineReadBatchResponseV1Schema.parse(response.data).results
      .flatMap(result => result.status === 'found' ? [result.machine] : []) : response.data;
    return await projectCurrentAccountMachineInventory({ ...params, serverHttpBaseUrl },
      exactId === undefined ? data : readCurrentAccountMachinePublicationRows(response), demandedIds);
  } catch (error) {
    params.signal?.throwIfAborted();
    throw machineInventoryUnavailable(error);
  }
}

function acceptsCurrentAccountMachinePublicationStatus(status: number): boolean {
  return status === 404 || status >= 200 && status < 300;
}

function machineInventoryUnavailable(error: unknown) {
  return Object.assign(new Error('The current machine inventory is unavailable.'), { code: 'machine_inventory_unavailable', cause: error });
}

function readCurrentAccountMachinePublicationRows(publication: Readonly<{ status: number; data: unknown }>): unknown {
  return publication.status === 404 ? [] : [z.object({ machine: ACCOUNT_MACHINE_ROW_SCHEMA }).parse(publication.data).machine];
}

/** Project one authenticated full publication without another admission read. */
export async function readCurrentAccountMachineHostFactsFromPublication(params: Readonly<{
  publication: Promise<Readonly<{ status: number; data: unknown }>>;
  machineId: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
}>): Promise<readonly CurrentAccountMachineInventoryItem[]> {
  params.signal?.throwIfAborted();
  try {
    const publication = await params.publication;
    params.signal?.throwIfAborted();
    if (!acceptsCurrentAccountMachinePublicationStatus(publication.status))
      throw createHttpStatusError(publication.status, 'Machine inventory publication request failed');
    return await projectCurrentAccountMachineInventory({ projection: 'hostFacts', serverHttpBaseUrl: params.serverHttpBaseUrl,
      ...(params.signal ? { signal: params.signal } : {}) }, readCurrentAccountMachinePublicationRows(publication), new Set([params.machineId]));
  } catch (error) {
    params.signal?.throwIfAborted();
    throw machineInventoryUnavailable(error);
  }
}

async function projectCurrentAccountMachineInventory(
  params: Pick<Parameters<typeof listCurrentAccountMachines>[0], 'credentials' | 'projection' | 'signal'>
    & Readonly<{ serverHttpBaseUrl: string }>,
  data: unknown,
  demandedIds?: ReadonlySet<string>,
): Promise<readonly CurrentAccountMachineInventoryItem[]> {
  const inventory = ACCOUNT_MACHINE_INVENTORY_SCHEMA.safeParse(data);
  if (!inventory.success) throw new Error('invalid machine inventory');
  const rows = demandedIds === undefined ? inventory.data : inventory.data.filter(row => demandedIds.has(row.id));
  let accountMode: Promise<'plain' | 'e2ee' | 'unknown'> | undefined;
  const readAccountMode = (credentials: StoredCredentials) => accountMode ??= readAccountEncryptionModeOnce({ credentials, request: () => axios.get(
    `${params.serverHttpBaseUrl}/v1/account/encryption`, { headers: { Authorization: `Bearer ${credentials.token}` },
      timeout: 20_000, ...(params.signal ? { signal: params.signal } : {}) },
  ) }).then(mode => mode.kind === 'resolved' ? mode.mode : 'unknown' as const).catch(() => 'unknown' as const);
  const namedMachines = await Promise.all(rows.map(async (row) => {
    let metadata: ReturnType<typeof StoredMachinePublishedMetadataV1Schema.parse> | undefined;
    if (params.projection !== 'hostFacts' && params.credentials && row.metadata && (!row.access || row.access.accessState === 'ready')) {
      try {
        const declaredMode = row.access?.resourceMode ?? row.storageMode;
        const expectedAccountMode = declaredMode === 'plain' || declaredMode === 'e2ee' ? declaredMode : await readAccountMode(params.credentials);
        const codec = resolvePublishedMachineContentCodec({ credentials: params.credentials, machineId: row.id,
          expectedAccountMode, access: row.access, publishedDataEncryptionKey: row.dataEncryptionKey,
          machineKind: row.kind, installationId: typeof row.installationId === 'string' ? row.installationId : null,
          runnerContentKeyBinding: row.runnerContentKeyBinding });
        const decoded = StoredMachinePublishedMetadataV1Schema.safeParse(codec.decodeStored(row.metadata));
        if (decoded.success) metadata = decoded.data;
      } catch {
        // Unavailable or inconsistent content is unknown, never a plain fallback.
        params.signal?.throwIfAborted();
      }
    }
    params.signal?.throwIfAborted();
    const nameMetadata = params.projection === 'hostFacts' ? null
      : metadata ?? (params.credentials ? null : readMachineNameMetadata(row.metadata));
    return {
      host: nameMetadata?.host,
      machine: {
        id: row.id, label: readMachineName(nameMetadata) ?? row.id, kind: row.kind, active: row.active,
        managedMachineRef: row.managedMachineRef,
        ...(row.managedInputRuntime !== undefined ? { managedInputRuntime: row.managedInputRuntime } : {}),
        installationId: row.installationId,
        revokedAt: row.revokedAt, replacedByMachineId: row.replacedByMachineId,
        ...(row.activeAt === undefined ? {} : { activeAt: row.activeAt }),
        ...(row.presenceProtocolVersion === undefined ? {} : { presenceProtocolVersion: row.presenceProtocolVersion }),
        ...(metadata ? { platform: metadata.platform, homeDir: metadata.homeDir, ...(metadata.arch === undefined ? {} : { arch: metadata.arch }) } : {}),
        ...(metadata?.agentInventory ? { agentInventory: metadata.agentInventory } : {}),
        ...(row.access ? { access: row.access } : {}),
        ...(row.deploymentApp === undefined ? {} : { deploymentApp: row.deploymentApp }),
        ...(row.sharedWithTeamScope ? { sharedWithTeamScope: row.sharedWithTeamScope } : {}),
        ...(params.projection !== 'hostFacts' && row.devcontainerChild ? { devcontainerChild: row.devcontainerChild } : {}),
        ...(params.projection === 'hostFacts' || row.operationProtocolCapabilities === undefined ? {} : { operationProtocolCapabilities: row.operationProtocolCapabilities }),
        ...(params.projection === 'hostFacts' || row.operationProtocolCapabilitiesRevision === undefined ? {} : { operationProtocolCapabilitiesRevision: row.operationProtocolCapabilitiesRevision }),
      },
    };
  }));
  if (params.projection === 'hostFacts') return namedMachines.map(({ machine }) => machine);
  const names = resolveMachineDisplayNameParts(namedMachines.map(({ host, machine }) => ({ id: machine.id, name: machine.label, host })));
  return namedMachines.map(({ machine }) => {
    const name = names.get(machine.id)!;
    return { ...machine, label: name.hint ? `${name.name} · ${name.hint}` : name.name };
  });
}

/** Only a returned original Machine can establish permanent cleanup unavailability; absence proves nothing. */
export async function readCurrentAccountMachinePreparationCleanupUnavailable(params: Readonly<{
  machineId: string; token?: string; authorization?: ExternalActionExecutionAuthorizationV1;
  serverHttpBaseUrl?: string; signal?: AbortSignal;
}>): Promise<Extract<MachineAvailabilityDiagnosticV1, { reason: 'machine_revoked' | 'machine_replaced' }>['reason'] | undefined> {
  const [machine] = await listCurrentAccountMachines({ ...params, projection: 'hostFacts', machineIds: [params.machineId] });
  // No reachability probe is needed: the canonical resolver decides revoked and replaced before offline.
  const readiness = resolveMachineSpawnReadinessV1({ selectedMachineId: params.machineId, machine, machineReachable: false });
  if (readiness.status === 'revoked') return 'machine_revoked';
  if (readiness.status === 'replaced') return 'machine_replaced';
  return undefined;
}

/**
 * Background Account administration preserves explicit targets and otherwise lists the reachable daemons in the
 * exact Home, preferred Machine first. Presence is only the first filter: a Machine row whose daemon is connected
 * to another server still looks present, so a caller that reads through one Machine tries the next on a
 * target-unavailable verdict (`isMachineRequestReachabilityFailureV1`).
 */
export async function listCurrentAccountAdministrationMachines(params: Parameters<typeof listCurrentAccountMachines>[0]
  & Readonly<{ token: string; requestedMachineId?: string; preferredMachineId?: string | null; requiredPluginId?: string }>): Promise<readonly string[]> {
  if (params.requestedMachineId !== undefined) {
    const resolution = await resolveCurrentAccountMachineTarget(params);
    return resolution.kind === 'selected' ? [resolution.target.machineId] : [];
  }
  const machines = await listCurrentAccountMachines({ ...params, projection: 'hostFacts' });
  let pluginMachines: ReadonlySet<string> | undefined;
  if (params.requiredPluginId) {
    try {
      const projection = params.authorization?.requesterHttpProjection;
      const path = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'];
      const headers = projection ? await projection.createRequestHeaders({ method: 'POST', path, body: {},
        effectActionId: params.effectActionId ?? params.authorization!.binding.actionId,
        ...(params.signal ? { signal: params.signal } : {}),
      }) : { Authorization: `Bearer ${params.token}` };
      if (!headers) throw new Error('Requester plugin inventory authority is unavailable');
      const home = normalizeServerHttpBaseUrl(params.serverHttpBaseUrl ?? projection?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl());
      const response = await axios.post(`${home}${path}`, {}, {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers },
        timeout: 0, ...(params.signal ? { signal: params.signal } : {}),
      });
      params.signal?.throwIfAborted();
      if (projection && !await projection.isCurrent()) throw new Error('Requester plugin inventory authority retired');
      const census = PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse(response.data);
      if (!census.inventoryComplete) throw new Error('Plugin inventory is incomplete');
      pluginMachines = new Set(census.snapshots.flatMap(snapshot => snapshot.materializations
        .filter(entry => entry.pluginId === params.requiredPluginId && entry.enabled && entry.trustState === 'trusted')
        .map(entry => entry.machineId)));
    } catch (error) {
      params.signal?.throwIfAborted();
      throw Object.assign(new Error('The current plugin Machine inventory is unavailable.'), { code: 'machine_inventory_unavailable', cause: error });
    }
  }
  const reachable = machines.filter(machine => machine.kind === 'persistent' && !machine.replacedByMachineId
    && (!pluginMachines || pluginMachines.has(machine.id))
    && (!machine.access || machine.access.accessState === 'ready') && isMachineReachableV1({ machine, nowMs: Date.now() }))
    .map(machine => machine.id);
  return params.preferredMachineId && reachable.includes(params.preferredMachineId)
    ? [params.preferredMachineId, ...reachable.filter(id => id !== params.preferredMachineId)] : reachable;
}

export async function resolveCurrentAccountAdministrationMachine(params: Parameters<typeof listCurrentAccountAdministrationMachines>[0]): Promise<string | null> {
  return (await listCurrentAccountAdministrationMachines(params))[0] ?? null;
}

/**
 * Resolves an automatic current-daemon target from the authenticated account inventory.
 *
 * This is the single API-inventory owner for callers without an explicit
 * target or daemon-local default. An explicit machine id already names the
 * Action target, so it must not depend on inventory availability; the Action
 * ingress owns validating that target. Automatic selection accepts both the
 * stored credential inventory shape and the API-token bootstrap shape, whose
 * rows deliberately omit machine metadata.
 */
export async function resolveCurrentAccountMachineTarget(params: Readonly<{
  token: string;
  requestedMachineId?: string;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
}>): Promise<CurrentAccountMachineTargetResolution> {
  params.signal?.throwIfAborted();
  const requestedMachineId = nonEmptyString(params.requestedMachineId);
  if (params.requestedMachineId !== undefined) {
    return requestedMachineId
      ? {
        kind: 'selected',
        target: { machineId: requestedMachineId, machineLabel: requestedMachineId },
      }
      : unavailable('machine_not_current', 'The selected machine is no longer active.');
  }

  try {
    const inventory = await listCurrentAccountMachines(params);
    const candidates = inventory
      // A restricted Runner is a Session-scoped target chosen explicitly, never
      // an automatic current-daemon selection.
      .filter((row) => (
        row.kind === 'persistent'
        && isMachineReachableV1({ machine: row }) && row.revokedAt === null && row.replacedByMachineId === null
        && (!row.access || row.access.accessState === 'ready')
      ))
      .map((row) => ({ machineId: row.id, machineLabel: row.label }));
    if (candidates.length === 0) {
      const currentMachines = inventory.filter(row => row.kind === 'persistent'
        && row.revokedAt === null && row.replacedByMachineId === null);
      if (currentMachines.every(row => !isMachineReachableV1({ machine: row }))) return {
        kind: 'unavailable', code: 'machine_offline', message: 'No active machine is available.',
        details: { machineIds: currentMachines.map(row => row.id) },
      };
      return unavailable('no_current_machine', 'No current machine is available.');
    }
    if (candidates.length > 1) return { kind: 'selection_required', candidates };
    return { kind: 'selected', target: candidates[0]! };
  } catch {
    params.signal?.throwIfAborted();
    return unavailable('machine_inventory_unavailable', 'The current machine inventory is unavailable.');
  }
}
