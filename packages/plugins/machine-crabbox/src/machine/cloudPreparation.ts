import { buildMachineProvisionerPreparationInstallScript, quoteMachineProvisionerShellArgument as quote } from '@happier-dev/plugin-sdk/machine-provisioners';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { computeSha256HexDigest, type PluginInvocationContext, type PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas,
  projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CrabboxLaunchV1Schema, type CrabboxLaunchV1 } from './schemas.js';
import { CRABBOX_COORDINATOR_PROVISIONER_ID, CRABBOX_PLUGIN_ID } from './constants.js';
import { CrabboxCoordinatorClient } from './nativeClient.js';
import type { prepareCrabboxConnection } from './connection.js';
import { CrabboxDependencyUnavailable, crabboxLeaseId } from './provider.js';
import { createCrabboxNativeStateExecution } from './nativeExecution.js';

const closed = { policy: 'closed' } as const;
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const scope = defineProtocolString({ pattern: '^[a-f0-9]{64}$' });
const operationShape = { operationId: text, launch: CrabboxLaunchV1Schema,
  coordinatorScope: scope.optional(),
  leaseId: defineProtocolString({ pattern: '^cbx_[0-9a-f]{12}$' }),
  checkpointId: defineProtocolString({ pattern: '^chk_[A-Za-z0-9_-]{1,96}$' }), name: text };
export const CrabboxCloudPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(CrabboxLaunchV1Schema);
export const CrabboxCloudPreparationOperationSchema = defineProtocolObject(operationShape, closed);
export const CrabboxCloudPreparedArtifactSchema = defineProtocolObject({ ...operationShape, coordinatorScope: scope, imageId: text }, closed);
export const CRABBOX_CLOUD_PREPARATION = defineMachineProvisionerPreparationSchemas({ input: CrabboxCloudPreparationInputSchema,
  launch: CrabboxLaunchV1Schema, artifact: CrabboxCloudPreparedArtifactSchema, nativeOperation: CrabboxCloudPreparationOperationSchema });
type Operation = ProtocolSchemaOutput<typeof CrabboxCloudPreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof CrabboxCloudPreparedArtifactSchema>;
type BuildInput = ProtocolSchemaOutput<typeof CrabboxCloudPreparationInputSchema>;
type BuildResult = ReturnType<typeof CRABBOX_CLOUD_PREPARATION.buildResult.parse>;
type InspectResult = ReturnType<typeof CRABBOX_CLOUD_PREPARATION.inspectResult.parse>;
type DestroyResult = ReturnType<typeof CRABBOX_CLOUD_PREPARATION.destroyResult.parse>;
type OperationInput = Pick<Operation, 'operationId' | 'launch'> & Partial<Omit<Operation, 'operationId' | 'launch'>> & { imageId?: string };
const contributionRef = { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_COORDINATOR_PROVISIONER_ID };
const checkpointSchema = defineProtocolObject({ id: text, leaseID: text, name: text, provider: text, target: text, strategy: text, state: text,
  retryAt: text.optional(),
  image: defineProtocolObject({ id: text, kind: text, architecture: text.optional() }, open).optional() }, open);
const sourceSchema = defineProtocolObject({ id: text, provider: text, org: text, state: text }, open);
function failure(code: string) { return Object.assign(new Error(code), { code }); }
function code(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'native_preparation_unconfirmed';
}
type CloudLaunch = Extract<CrabboxLaunchV1, { backendId: 'aws' | 'gcp' }>;
function supported(launch: CrabboxLaunchV1): launch is CloudLaunch {
  return launch.transport === 'coordinator' && (launch.backendId === 'aws' || launch.backendId === 'gcp');
}
function operation(input: OperationInput, coordinatorScope?: string): Operation {
  const launch = CrabboxLaunchV1Schema.parse(input.launch);
  const operationId = text.parse(input.operationId);
  const hash = computeSha256HexDigest(operationId);
  const expected = { operationId, launch, coordinatorScope: input.coordinatorScope ?? coordinatorScope, leaseId: crabboxLeaseId('prepare:' + operationId),
    checkpointId: 'chk_' + hash, name: 'happier-prepared-' + hash };
  if (input.leaseId !== undefined && input.leaseId !== expected.leaseId
    || input.checkpointId !== undefined && input.checkpointId !== expected.checkpointId
    || input.name !== undefined && input.name !== expected.name) throw failure('native_checkpoint_identity_mismatch');
  return expected;
}
function stateRoot(operation: Operation) { return join(tmpdir(), 'happier-crabbox-prepare-' + computeSha256HexDigest(operation.operationId)); }
function completed(result: PluginProcessResult) {
  return result.termination.requestedBy.kind === 'none' && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0;
}
async function prepareState(root: string) {
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) {
    if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    const existing = await lstat(root);
    if (!existing.isDirectory() || process.getuid && existing.uid !== process.getuid()
      || process.platform !== 'win32' && (existing.mode & 0o077) !== 0) throw failure('native_builder_state_unavailable');
  }
}
async function stateExists(op: Operation) {
  try { await lstat(stateRoot(op)); return true; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
function buildScript(input: BuildInput) {
  const files = input.cli.files.map(file => {
    const path = posix.normalize(file.path);
    if (file.path.includes('\\') || posix.isAbsolute(path) || path === '..' || path.startsWith('../') || path === '.') throw failure('invalid_request');
    return `mkdir -p -- ${quote(posix.dirname(path))}\nprintf %s ${quote(file.contentsBase64)} | decode > ${quote(path)}\n`;
  }).join('');
  return Buffer.from('#!/bin/sh\nset -eu\nif [ "$(id -u)" -ne 0 ]; then exec sudo -n -- sh "$0" "$@"; fi\n'
    + 'decode() { if [ "$(uname -s)" = Darwin ]; then base64 -D; else base64 -d; fi; }\n'
    + 'stage=$(mktemp -d)\ntrap \'rm -rf -- "$stage"\' EXIT\ncd "$stage"\n' + files
    + buildMachineProvisionerPreparationInstallScript({ cli: input.cli, readableRoot: '/opt/happier', setupScript: input.setupScript })
    + 'cd /\nrm -rf -- "$stage"\ntrap - EXIT\n'
    // Only this fresh native-owned source is captured. No enrollment, Account
    // credentials, repository sync, inherited env or ordinary resource key.
    + 'if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null; cloud-init clean --logs; fi\n'
    + 'rm -f /etc/ssh/ssh_host_* /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys /Users/*/.ssh/authorized_keys\nsync\n');
}

/** Native v0.72.0 (81226dc): warmup/run own the fresh SSH source; the
 * coordinator owns checkpoint creation/deletion and exact source retirement.
 * Keys remain in its private native state, never in supplier input or refs. */
export function createCrabboxCloudPreparation(context: PluginInvocationContext,
  prepared: Awaited<ReturnType<typeof prepareCrabboxConnection>>, invokingContribution: PluginContributionRef = contributionRef) {
  const reference = <T>(value: T) => ({ contributionRef: invokingContribution, schemaVersion: 1 as const, value });
  const { connection, http } = prepared;
  const endpoint = connection.endpoint.replace(/\/+$/, '');
  const coordinatorScope = computeSha256HexDigest(JSON.stringify([new URL(connection.endpoint).toString().replace(/\/+$/, ''), connection.namespace]));
  const coordinator = new CrabboxCoordinatorClient(connection, http);
  const unknown = (op: Operation, reason = 'native_preparation_unconfirmed') =>
    ({ kind: 'unknown' as const, code: reason, nativeOperationRef: reference(op) });
  const caught = (error: unknown, op: Operation) => projectMachineProvisionerActionFailure(error, () => unknown(op, code(error)));
  async function request(path: string, method = 'GET', body?: unknown) {
    context.signal.throwIfAborted();
    const response = await http(endpoint + path, { method, signal: context.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Crabbox-Org': connection.namespace, Authorization: `Bearer ${connection.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw failure('native_preparation_unconfirmed');
    return await response.json() as unknown;
  }
  function checkLaunch(op: Operation) {
    if (!supported(op.launch)) throw failure('crabbox_preparation_not_supported');
    if (op.launch.namespace !== connection.namespace) throw failure('native_checkpoint_identity_mismatch');
    if (op.coordinatorScope !== undefined && op.coordinatorScope !== coordinatorScope) throw failure('native_checkpoint_scope_mismatch');
  }
  function checkpoint(raw: unknown, op: Operation, imageId?: string) {
    const value = defineProtocolObject({ checkpoint: checkpointSchema }, open).parse(raw).checkpoint;
    if (value.id !== op.checkpointId || value.leaseID !== op.leaseId || value.name !== op.name
      || value.provider !== op.launch.backendId || value.target !== op.launch.target || value.strategy !== 'image'
      || imageId !== undefined && value.state !== 'deleted' && value.image?.id !== imageId) throw failure('native_checkpoint_identity_mismatch');
    return value;
  }
  const checkpointPath = (op: Operation) => '/v1/checkpoints/' + encodeURIComponent(op.checkpointId);
  async function readCheckpoint(op: Operation, imageId?: string) {
    const raw = await request(checkpointPath(op));
    return raw === undefined ? undefined : checkpoint(raw, op, imageId);
  }
  async function sourceState(op: Operation): Promise<'absent' | 'present' | 'ended'> {
    const raw = await request('/v1/leases/' + op.leaseId);
    if (raw === undefined) return 'absent';
    const source = defineProtocolObject({ lease: sourceSchema }, open).parse(raw).lease;
    if (source.id !== op.leaseId || source.provider !== op.launch.backendId || source.org !== op.launch.namespace) throw failure('native_checkpoint_identity_mismatch');
    if (source.state === 'released' && (op.launch.backendId === 'aws' || op.launch.backendId === 'gcp')) {
      if ((await coordinator.inspect({ backendId: op.launch.backendId, transport: 'coordinator', namespace: op.launch.namespace, leaseId: op.leaseId }, context.signal)).cleanup === 'confirmed') return 'ended';
    }
    return 'present';
  }
  async function retire(op: Operation, removeState = false) {
    const source = await sourceState(op);
    if (source === 'absent') return !await stateExists(op);
    if (source === 'ended') { if (removeState) await rm(stateRoot(op), { recursive: true, force: true }); return true; }
    if (op.launch.backendId !== 'aws' && op.launch.backendId !== 'gcp') throw failure('crabbox_preparation_not_supported');
    // Reuse the canonical native lease cleanup classifier, including pending
    // and physical cleanup facts; release acceptance alone is not proof.
    const observed = await coordinator.destroy({ backendId: op.launch.backendId, transport: 'coordinator', namespace: op.launch.namespace, leaseId: op.leaseId }, context.signal);
    if (observed.cleanup !== 'confirmed') return false;
    if (removeState) await rm(stateRoot(op), { recursive: true, force: true });
    return true;
  }
  async function classify(value: ProtocolSchemaOutput<typeof checkpointSchema>, op: Operation): Promise<InspectResult> {
    op = { ...op, coordinatorScope };
    if (!supported(op.launch)) throw failure('crabbox_preparation_not_supported');
    if (value.state === 'deleted') {
      const source = await sourceState(op);
      return source === 'ended' || source === 'absent' && !await stateExists(op)
        ? { kind: 'absent' } : unknown(op, 'native_build_source_retained');
    }
    if (value.state === 'failed') return value.retryAt ? { kind: 'pending', nativeOperationRef: reference(op) }
      : { kind: 'failed', code: 'native_checkpoint_failed', nativeOperationRef: reference(op) };
    if (value.state === 'creating' || value.state === 'delete-pending' || value.state === 'deleting') return { kind: 'pending', nativeOperationRef: reference(op) };
    if (value.state !== 'ready' || !value.image) return unknown(op, 'native_checkpoint_state_unsupported');
    if (value.image.kind !== (op.launch.backendId === 'aws' ? 'aws-ami' : 'gcp-machine-image')) return unknown(op, 'native_checkpoint_image_unsupported');
    if (value.image.architecture !== undefined && !['amd64', 'x86_64', 'x86_64_mac'].includes(value.image.architecture)) return unknown(op, 'native_checkpoint_architecture_mismatch');
    // A ready checkpoint owns an image that may still be building. This native
    // endpoint verifies immutable ownership and refreshes the provider state.
    const verified = await request(checkpointPath(op) + '?verify=true');
    if (verified === undefined) return unknown(op);
    checkpoint(verified, op, value.image.id);
    const image = defineProtocolObject({ image: defineProtocolObject({ id: text, state: text }, open) }, open).parse(verified).image;
    if (image.id !== value.image.id) throw failure('native_checkpoint_identity_mismatch');
    const imageState = image.state.toLowerCase();
    if (imageState === 'failed' || imageState === 'invalid') return { kind: 'failed', code: 'native_checkpoint_image_failed', nativeOperationRef: reference(op) };
    if (!['available', 'ready', 'succeeded', 'completed'].includes(imageState)) return { kind: 'pending', nativeOperationRef: reference(op) };
    if (await sourceState(op) !== 'ended') return { kind: 'pending', nativeOperationRef: reference(op) };
    const artifact: Artifact = { ...op, coordinatorScope, imageId: value.image.id,
      launch: { ...op.launch, nativeImageId: value.image.id, nativeCheckpointId: op.checkpointId } };
    return { kind: 'ready', artifact: reference(artifact) };
  }
  async function inspect(raw: OperationInput): Promise<InspectResult> {
    const op = operation(raw);
    try {
      checkLaunch(op);
      const value = await readCheckpoint(op, raw.imageId);
      if (value) return await classify(value, op);
      const source = await sourceState(op);
      if (source === 'present') return unknown({ ...op, coordinatorScope }, 'native_build_source_retained');
      if (source === 'ended') return await stateExists(op)
        ? unknown({ ...op, coordinatorScope }, 'native_builder_unconfirmed') : { kind: 'absent' };
      // Native warmup may still be acquiring before the first coordinator
      // lease observation. Its owned state keeps this operation recoverable.
      return await stateExists(op) ? unknown(op, 'native_builder_unconfirmed') : { kind: 'absent' };
    } catch (error) { return caught(error, op); }
  }
  async function build(id: string, input: BuildInput): Promise<BuildResult> {
    const definition = CrabboxCloudPreparationInputSchema.parse(input);
    const op = operation({ operationId: id, launch: definition.launch.choices }, coordinatorScope);
    if (!supported(op.launch)) return { kind: 'refused', code: 'crabbox_preparation_not_supported' };
    try {
      checkLaunch(op);
      const existing = await readCheckpoint(op);
      if (existing) return await finishBuild(existing, op);
      const retained = await inspect(op);
      if (retained.kind === 'failed') return unknown(op, retained.code);
      if (retained.kind !== 'absent') return retained;
      const script = buildScript(definition);
      const root = stateRoot(op);
      const launch = op.launch;
      if (!supported(launch)) throw failure('crabbox_preparation_not_supported');
      const imageEnvironment: Readonly<Record<string, string>> = launch.backendId === 'aws' ? { CRABBOX_AWS_AMI: launch.nativeImageId }
        : { CRABBOX_GCP_IMAGE: launch.nativeImageId, CRABBOX_GCP_PROJECT: launch.gcpProject, CRABBOX_GCP_ZONE: launch.gcpZone };
      const run = await createCrabboxNativeStateExecution(context, root, { CRABBOX_COORDINATOR: connection.endpoint,
        CRABBOX_COORDINATOR_TOKEN: connection.token, CRABBOX_COORDINATOR_MODE: 'managed', CRABBOX_ORG: connection.namespace, ...imageEnvironment });
      await prepareState(root);
      const warmed = await run(['warmup', '--provider', launch.backendId, '--target', launch.target, '--arch', 'amd64',
        '--lease-id', op.leaseId, '--keep', '--type', launch.nativeSizeId,
        '--ttl', `${launch.ttlSeconds}s`, '--idle-timeout', `${launch.idleTimeoutSeconds}s`]);
      if (!completed(warmed)) return unknown(op, 'native_builder_unconfirmed');
      if (!completed(await run(['run', '--provider', launch.backendId, '--id', op.leaseId, '--keep', '--no-sync', '--no-hydrate', '--script-stdin'], script)))
        return unknown(op, 'native_build_unconfirmed');
      const captured = await request('/v1/checkpoints', 'POST', { id: op.checkpointId, leaseID: op.leaseId, name: op.name,
        strategy: 'image', noReboot: true, retention: { mode: 'manual' } });
      if (captured === undefined) return unknown(op);
      return await finishBuild(checkpoint(captured, op), op);
    } catch (error) {
      if (error instanceof CrabboxDependencyUnavailable) return { kind: 'refused', code: error.code };
      return caught(error, op);
    }
  }
  async function finishBuild(value: ProtocolSchemaOutput<typeof checkpointSchema>, op: Operation): Promise<BuildResult> {
    // Native publication proves the independent AMI backing snapshots exist;
    // GCP publication follows its completed machine-image operation. Source
    // retirement can proceed while the owned image is still becoming usable.
    if (value.state === 'ready' && value.image) await retire(op);
    const observed = await classify(value, op);
    return observed.kind === 'failed' || observed.kind === 'absent' ? unknown(op) : observed;
  }
  async function destroy(raw: OperationInput): Promise<DestroyResult> {
    let op = operation(raw);
    try {
      checkLaunch(op);
      const before = await readCheckpoint(op, raw.imageId);
      if (op.coordinatorScope === undefined) {
        if (!before) return unknown(op, 'native_checkpoint_scope_unproven');
        op = { ...op, coordinatorScope };
      }
      if (before && before.state !== 'deleted') {
        const deleted = await request(checkpointPath(op), 'DELETE');
        if (deleted !== undefined) {
          const confirmation = defineProtocolObject({ checkpointID: text, deleted: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, open).parse(deleted);
          if (confirmation.checkpointID !== op.checkpointId) throw failure('native_checkpoint_identity_mismatch');
          if (!confirmation.deleted) return { kind: 'pending', nativeOperationRef: reference(op) };
        }
      }
      return await retire(op, true) ? { kind: 'confirmed' } : { kind: 'pending', nativeOperationRef: reference(op) };
    } catch (error) { return caught(error, op); }
  }
  return { build, inspect, destroy };
}
