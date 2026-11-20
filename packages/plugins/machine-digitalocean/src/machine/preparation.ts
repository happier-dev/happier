import { isMachineProvisionerCreateRefusal, buildMachineProvisionerPreparationInstallScript, quoteMachineProvisionerShellArgument as quote } from '@happier-dev/plugin-sdk/machine-provisioners';
import { computeSha256HexDigest } from '@happier-dev/plugin-sdk';
import * as z from 'zod/mini';
import { defineProtocolNumber, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createDigitalOceanTransport, type DigitalOceanTransportOptions, type Unavailable } from './transport.js';
import { dropletLaunchSchema, nativeDropletSchema, nativeActionSchema, reference, type DropletLaunchV1 } from './schemas.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
const id = defineProtocolNumber({ integer: true, minimum: 1 });
export const DIGITALOCEAN_PREPARATION_HOME = '/opt/happier';
export const DigitalOceanPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(dropletLaunchSchema);
export const DigitalOceanPreparedArtifactSchema = defineProtocolObject({ operationTag: text, dropletId: id, snapshotId: text, launch: dropletLaunchSchema }, closed);
export const DigitalOceanPreparationOperationSchema = defineProtocolObject({ operationTag: text, launch: dropletLaunchSchema, dropletId: id.optional(), snapshotId: text.optional() }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: DigitalOceanPreparationInputSchema,
  launch: dropletLaunchSchema, artifact: DigitalOceanPreparedArtifactSchema, nativeOperation: DigitalOceanPreparationOperationSchema });
type BuildInput = ProtocolSchemaOutput<typeof DigitalOceanPreparationInputSchema>;
type Artifact = ProtocolSchemaOutput<typeof DigitalOceanPreparedArtifactSchema>;
type Operation = ProtocolSchemaOutput<typeof DigitalOceanPreparationOperationSchema>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const nativeId = z.int().check(z.gt(0));
const dropletSchema = z.extend(nativeDropletSchema, { snapshot_ids: z.array(nativeId) });
const snapshotSchema = z.object({ id: z.string().check(z.regex(/^[1-9][0-9]*$/)), name: z.string(), resource_id: z.string(),
  resource_type: z.literal('droplet'), regions: z.array(z.string()), tags: z.nullable(z.array(z.string())) });
type Snapshot = z.infer<typeof snapshotSchema>;
type Source = z.infer<typeof dropletSchema>;
class PreparationError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}
function operationFor(operationId: string, launch: DropletLaunchV1): Operation {
  return { operationTag: 'happier-prepared-' + computeSha256HexDigest(text.parse(operationId)), launch };
}
function parse<T>(schema: z.ZodMiniType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PreparationError('digitalocean_preparation_invalid_response');
  return result.data;
}
function userData(input: BuildInput) {
  return ['#!/bin/sh', 'set -eu', 'umask 077', 'export HOME=' + quote(DIGITALOCEAN_PREPARATION_HOME),
    'mkdir -p -- "$HOME"', 'stage="$(mktemp -d)"', 'trap \'rm -rf -- "$stage"\' EXIT', 'cd -- "$stage"',
    ...input.cli.files.flatMap(file => ['mkdir -p -- "$(dirname -- ' + quote(file.path) + ')"',
      'printf %s ' + quote(file.contentsBase64) + ' | base64 -d > ' + quote(file.path)]),
    buildMachineProvisionerPreparationInstallScript({ cli: input.cli, readableRoot: DIGITALOCEAN_PREPARATION_HOME, setupScript: input.setupScript }),
    'cd /', 'rm -rf -- "$stage"', 'trap - EXIT', 'sync', 'poweroff', ''].join('\n');
}

// DigitalOcean REST v2, official snapshots/tags/droplets API, 2026-11-16.
// Build uses a fresh guest from the selected image and no enrollment or Account material.
export function createDigitalOceanPreparationClient(options: DigitalOceanTransportOptions & { waitForObservation: () => Promise<void> }) {
  const transport = createDigitalOceanTransport(options);
  async function http(path: string, method = 'GET', body?: unknown, acceptNotFound = false) {
    options.signal?.throwIfAborted();
    const result = await transport.request(path, method, body, acceptNotFound);
    if (result.kind === 'unavailable') throw unavailable(result);
    return result;
  }
  function unavailable(result: Unavailable) {
    return new PreparationError('digitalocean_preparation_' + (result.nativeCause?.code ?? result.reason.replaceAll('-', '_')), result.status);
  }
  async function collection<T>(path: string, key: string, schema: z.ZodMiniType<T>) {
    const result = await transport.collection(path, key, schema);
    if (result.kind === 'unavailable') throw unavailable(result);
    return result.values;
  }
  function failure(error: unknown, operation: Operation, refuse = false) {
    return projectMachineProvisionerActionFailure(error, () => {
      const code = error instanceof PreparationError ? error.code : 'action_failed';
      return refuse && error instanceof PreparationError && (error.code === 'digitalocean_preparation_identity_mismatch'
        || isMachineProvisionerCreateRefusal(error.status, [409, 429]))
        ? { kind: 'refused' as const, code } : { kind: 'unknown' as const, code, nativeOperationRef: reference(operation) };
    });
  }
  function checkSource(source: Source, operation: Operation) {
    if (!source.tags.includes(operation.operationTag) || operation.dropletId !== undefined && source.id !== operation.dropletId) {
      throw new PreparationError('digitalocean_preparation_identity_mismatch');
    }
    return source;
  }
  async function sourceFor(operation: Operation): Promise<Source | null> {
    if (operation.dropletId !== undefined) {
      const result = await http('/droplets/' + operation.dropletId, 'GET', undefined, true);
      return result.status === 404 ? null : checkSource(parse(z.object({ droplet: dropletSchema }), result.body).droplet, operation);
    }
    const recovered = await transport.recoverTaggedDroplet(operation.operationTag, dropletSchema);
    if (recovered.kind === 'unavailable') throw unavailable(recovered);
    if (recovered.kind === 'unknown') {
      if (recovered.reason === 'ambiguous') throw new PreparationError('digitalocean_preparation_identity_ambiguous');
      return null;
    }
    return checkSource(recovered.droplet, operation);
  }
  async function snapshotFor(snapshotId: string) {
    const result = await http('/snapshots/' + encodeURIComponent(snapshotId), 'GET', undefined, true);
    return result.status === 404 ? null : parse(z.object({ snapshot: snapshotSchema }), result.body).snapshot;
  }
  async function locate(operation: Operation) {
    const source = await sourceFor(operation);
    const ids = operation.snapshotId ? [operation.snapshotId] : source ? source.snapshot_ids.map(String)
      : (await collection('/images?tag_name=' + encodeURIComponent(operation.operationTag), 'images', z.object({ id: nativeId }))).map(image => String(image.id));
    const candidates: Snapshot[] = [];
    for (const snapshotId of ids) {
      const snapshot = await snapshotFor(snapshotId);
      if (snapshot === null) continue;
      if (!operation.snapshotId && snapshot.name !== operation.operationTag && !snapshot.tags?.includes(operation.operationTag)) continue;
      const expectedSourceId = operation.dropletId ?? source?.id;
      if (snapshot.id !== snapshotId || snapshot.name !== operation.operationTag || !snapshot.regions.includes(operation.launch.regionSlug)
        || expectedSourceId !== undefined && snapshot.resource_id !== String(expectedSourceId)
        || source === null && !snapshot.tags?.includes(operation.operationTag)) throw new PreparationError('digitalocean_preparation_identity_mismatch');
      candidates.push(snapshot);
    }
    if (candidates.length > 1) throw new PreparationError('digitalocean_preparation_identity_ambiguous');
    const snapshot = candidates[0] ?? null;
    const sourceId = source?.id ?? (snapshot ? parse(nativeId, Number(snapshot.resource_id)) : operation.dropletId);
    return { source, snapshot, operation: { ...operation, ...(sourceId === undefined ? {} : { dropletId: sourceId }),
      ...(snapshot ? { snapshotId: snapshot.id } : {}) } };
  }
  async function removeSource(source: Source, operation: Operation) {
    await http('/droplets/' + source.id, 'DELETE', undefined, true);
    return await sourceFor({ ...operation, dropletId: source.id }) === null;
  }
  async function adopt(found: Awaited<ReturnType<typeof locate>>): Promise<Extract<InspectResult, { kind: 'ready' | 'pending' | 'absent' }>> {
    const { source, snapshot, operation } = found;
    if (!snapshot) return source ? { kind: 'pending', nativeOperationRef: reference(operation) } : { kind: 'absent' };
    if (source) {
      if (!snapshot.tags?.includes(operation.operationTag)) await http('/tags/' + encodeURIComponent(operation.operationTag) + '/resources', 'POST',
        { resources: [{ resource_id: snapshot.id, resource_type: 'image' }] });
      if (!await removeSource(source, operation)) return { kind: 'pending', nativeOperationRef: reference(operation) };
    }
    return ready(snapshot, operation);
  }
  function ready(snapshot: Snapshot, operation: Operation): Extract<InspectResult, { kind: 'ready' }> {
    const imageId = parse(nativeId, Number(snapshot.id));
    return { kind: 'ready', artifact: reference({ operationTag: operation.operationTag, dropletId: parse(nativeId, Number(snapshot.resource_id)),
      snapshotId: snapshot.id, launch: { ...operation.launch, imageId } }) };
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: DropletLaunchV1 }): Promise<InspectResult> {
    let operation = 'nativeOperation' in input ? DigitalOceanPreparationOperationSchema.parse(input.nativeOperation) : operationFor(input.operationId, input.launch);
    try {
      const found = await locate(operation); operation = found.operation;
      if (found.snapshot && found.source) return { kind: 'failed', code: 'digitalocean_preparation_cleanup_required', nativeOperationRef: reference(operation) };
      if (found.source) return { kind: 'pending', nativeOperationRef: reference(operation) };
      return found.snapshot ? ready(found.snapshot, operation) : { kind: 'absent' };
    }
    catch (error) {
      const result = await failure(error, operation);
      return result.kind === 'refused' ? { kind: 'unknown', code: result.code, nativeOperationRef: reference(operation) } : result;
    }
  }
  async function build(input: { operationId: string; input: BuildInput }): Promise<BuildResult> {
    const definition = DigitalOceanPreparationInputSchema.parse(input.input);
    let operation = operationFor(input.operationId, definition.launch.choices);
    let allocated = false;
    try {
      const cloudInit = userData(definition);
      // Official droplets_create user_data contract: plain text, at most 64 KiB.
      // Do not buy a guest for an archive that cannot traverse this vendor boundary.
      if (new TextEncoder().encode(cloudInit).byteLength > 64 * 1024) return { kind: 'refused', code: 'digitalocean_preparation_user_data_too_large' };
      const launch = operation.launch;
      const digest = operation.operationTag.slice('happier-prepared-'.length);
      const created = await http('/droplets', 'POST', { name: 'happier-prepared-' + digest.slice(0, 32) + '.' + digest.slice(32),
        region: launch.regionSlug, size: launch.sizeSlug, image: launch.imageId, ipv6: launch.publicNetworking.ipv6,
        tags: [operation.operationTag], user_data: cloudInit, with_droplet_agent: false });
      allocated = true;
      operation = { ...operation, dropletId: parse(z.object({ droplet: z.object({ id: nativeId }) }), created.body).droplet.id };
      let source = await sourceFor(operation);
      while (source && source.status !== 'off') {
        if (source.status !== 'new' && source.status !== 'active') throw new PreparationError('digitalocean_preparation_source_state_unsupported');
        // No vendor cloud-init-result API exists. Only our successful script powers
        // this cold guest off. Failure stays visibly pending until Stop/cleanup.
        await options.waitForObservation();
        source = await sourceFor(operation);
      }
      if (!source) throw new PreparationError('digitalocean_preparation_source_absent');
      let action = parse(z.object({ action: nativeActionSchema }), (await http('/droplets/' + source.id + '/actions', 'POST',
        { type: 'snapshot', name: operation.operationTag })).body).action;
      const actionId = action.id;
      while (true) {
        if (action.id !== actionId || action.type !== 'snapshot' || action.resource_id !== source.id) throw new PreparationError('digitalocean_preparation_identity_mismatch');
        if (action.status === 'errored') throw new PreparationError('digitalocean_preparation_snapshot_failed');
        if (action.status === 'completed') break;
        await options.waitForObservation();
        action = parse(z.object({ action: nativeActionSchema }), (await http('/actions/' + actionId)).body).action;
      }
      while (true) {
        const found = await locate(operation); operation = found.operation;
        const result = await adopt(found);
        if (result.kind === 'ready') return result;
        if (result.kind === 'absent') throw new PreparationError('digitalocean_preparation_source_absent');
        await options.waitForObservation();
      }
    } catch (error) { return failure(error, operation, !allocated); }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    const artifact = input.artifact && DigitalOceanPreparedArtifactSchema.parse(input.artifact);
    let operation: Operation = artifact ? { operationTag: artifact.operationTag, launch: artifact.launch,
      dropletId: artifact.dropletId, snapshotId: artifact.snapshotId } : DigitalOceanPreparationOperationSchema.parse(input.nativeOperation);
    try {
      const found = await locate(operation); operation = found.operation;
      if (found.source) {
        const actions = await collection('/droplets/' + found.source.id + '/actions', 'actions', nativeActionSchema);
        if (actions.some(action => action.resource_id !== found.source!.id)) throw new PreparationError('digitalocean_preparation_identity_mismatch');
        // A snapshot still being produced must settle before its source is removed,
        // or a newly materialized image could escape this cleanup operation.
        if (actions.some(action => action.type === 'snapshot' && action.status === 'in-progress')) return { kind: 'pending', nativeOperationRef: reference(operation) };
      }
      if (found.snapshot) {
        await http('/snapshots/' + encodeURIComponent(found.snapshot.id), 'DELETE', undefined, true);
        if (await snapshotFor(found.snapshot.id) !== null) return { kind: 'pending', nativeOperationRef: reference(operation) };
      }
      if (found.source && !await removeSource(found.source, operation)) return { kind: 'pending', nativeOperationRef: reference(operation) };
      return { kind: 'confirmed' };
    } catch (error) { return failure(error, operation, true); }
  }
  return { build, inspect, destroy };
}
