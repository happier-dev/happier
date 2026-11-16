import * as mini from 'zod/mini';
import { defineProtocolArray, defineProtocolNumber, defineProtocolObject, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createHetznerNativeTransport, type HetznerNativeClientOptions } from './nativeClient.js';
import { HetznerCorrelationSchema, HetznerLaunchV1Schema, HetznerNativeError, type HetznerLaunchV1 } from './schemas.js';

const closed = { policy: 'closed' } as const;
const id = defineProtocolNumber({ integer: true, minimum: 1 });
const fields = { operationId: HetznerCorrelationSchema, launch: HetznerLaunchV1Schema, serverId: id.optional(), primaryIpIds: defineProtocolArray(id) };
export const HETZNER_PREPARATION_HOME = '/opt/happier';
export const HetznerPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(HetznerLaunchV1Schema);
export const HetznerPreparationOperationSchema = defineProtocolObject(fields, closed);
export const HetznerPreparedArtifactSchema = defineProtocolObject({ ...fields, imageId: id }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: HetznerPreparationInputSchema,
  launch: HetznerLaunchV1Schema, artifact: HetznerPreparedArtifactSchema, nativeOperation: HetznerPreparationOperationSchema });
type Operation = ProtocolSchemaOutput<typeof HetznerPreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof HetznerPreparedArtifactSchema>;
type BuildInput = ProtocolSchemaOutput<typeof HetznerPreparationInputSchema>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const reference = <T>(value: T) => ({ contributionRef: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' }, schemaVersion: 1, value });
const nativeId = mini.number().check(mini.int(), mini.positive());
const labelsSchema = mini.record(mini.string(), mini.string());
const addressSchema = mini.nullable(mini.object({ id: nativeId }));
const serverSchema = mini.object({ id: nativeId, status: mini.string(), labels: labelsSchema,
  public_net: mini.object({ ipv4: addressSchema, ipv6: addressSchema }) });
const imageSchema = mini.object({ id: nativeId, type: mini.literal('snapshot'), status: mini.string(), labels: labelsSchema });
const actionSchema = mini.object({ id: nativeId, status: mini.enum(['success', 'running', 'error']) });
const labelKey = 'happier-preparation';

// REST v1 (official hcloud-python servers/client.py create/create_image):
// Hetzner has no image build endpoint. Only this fresh, unenrolled server is
// snapshotted. Success powers it off; failed setup remains running until the
// person cancels. There is deliberately no invented setup timeout or callback.
export function createHetznerPreparationClient(options: HetznerNativeClientOptions) {
  const { request, decode, list, waitForAction } = createHetznerNativeTransport(options);
  function owned(labels: Record<string, string>, operation: Operation) {
    if (labels[labelKey] !== operation.operationId) throw new HetznerNativeError('native_identity_mismatch');
  }
  function retained(server: mini.infer<typeof serverSchema>, operation: Operation): Operation {
    owned(server.labels, operation);
    if (operation.serverId !== undefined && server.id !== operation.serverId) throw new HetznerNativeError('native_identity_mismatch');
    return { ...operation, serverId: server.id, primaryIpIds: [server.public_net.ipv4?.id, server.public_net.ipv6?.id].filter((value): value is number => value !== undefined) };
  }
  function imageOperation(image: mini.infer<typeof imageSchema>, operation: Operation): Operation {
    owned(image.labels, operation);
    const serverId = Number(image.labels['happier-build-server']);
    const primaryIpIds = (image.labels['happier-build-ips'] ?? '').split('.').filter(Boolean).map(Number);
    if (!Number.isSafeInteger(serverId) || serverId <= 0 || primaryIpIds.some(value => !Number.isSafeInteger(value) || value <= 0)
      || operation.serverId !== undefined && operation.serverId !== serverId) throw new HetznerNativeError('native_identity_mismatch');
    return { ...operation, serverId, primaryIpIds };
  }
  async function server(operation: Operation) {
    if (operation.serverId === undefined) return null;
    const reply = await request('/servers/' + operation.serverId, 'GET', undefined, true);
    if (reply.kind === 'absent') return null;
    const value = decode(mini.object({ server: serverSchema }), reply).server;
    retained(value, operation);
    return value;
  }
  async function image(imageId: number, operation: Operation) {
    const reply = await request('/images/' + imageId, 'GET', undefined, true);
    if (reply.kind === 'absent') return null;
    const value = decode(mini.object({ image: imageSchema }), reply).image;
    if (value.id !== imageId) throw new HetznerNativeError('native_identity_mismatch');
    imageOperation(value, operation);
    return value;
  }
  async function discover(operation: Operation) {
    const query = 'label_selector=' + encodeURIComponent(labelKey + '=' + operation.operationId);
    const [images, servers] = await Promise.all([list('/images', 'images', imageSchema, 'type=snapshot&' + query), list('/servers', 'servers', serverSchema, query)]);
    for (const item of [...images, ...servers]) owned(item.labels, operation);
    if (images.length > 1 || servers.length > 1) throw new HetznerNativeError('native_identity_ambiguous');
    const nativeImage = images[0] ?? null, nativeServer = servers[0] ?? null;
    const value = nativeImage ? imageOperation(nativeImage, operation) : nativeServer ? retained(nativeServer, operation) : operation;
    if (nativeServer) retained(nativeServer, value);
    return { image: nativeImage, server: nativeServer, operation: value };
  }
  function failure(error: unknown, operation: Operation) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const,
      code: error instanceof HetznerNativeError ? error.code : 'native_transport_unavailable', nativeOperationRef: reference(operation) }));
  }
  async function retireServer(operation: Operation) {
    if (await server(operation) !== null) await request('/servers/' + operation.serverId, 'DELETE', undefined, true);
    if (await server(operation) !== null) return false;
    let absent = true;
    for (const ipId of operation.primaryIpIds) {
      const path = '/primary_ips/' + ipId;
      if ((await request(path, 'GET', undefined, true)).kind !== 'absent') await request(path, 'DELETE', undefined, true);
      if ((await request(path, 'GET', undefined, true)).kind !== 'absent') absent = false;
    }
    return absent;
  }
  function classify(nativeImage: mini.infer<typeof imageSchema>, operation: Operation): InspectResult {
    if (nativeImage.status === 'available') return { kind: 'ready', artifact: reference({ ...operation, imageId: nativeImage.id,
      launch: { ...operation.launch, imageId: String(nativeImage.id) } }) };
    if (nativeImage.status === 'creating') return { kind: 'pending', nativeOperationRef: reference(operation) };
    return { kind: 'failed', code: 'native_snapshot_failed', nativeOperationRef: reference(operation) };
  }
  function cloudInit(input: BuildInput) {
    // cloud-init warns that /tmp can be removed by systemd-tmpfiles during boot.
    const directory = '/var/tmp/happier-preparation';
    const files = input.cli.files.map(file => ({ path: directory + '/context/' + file.path, encoding: 'b64', permissions: '0600', content: file.contentsBase64 }));
    const script = 'set -eu\nmkdir -p ' + directory + '/context\ncd ' + directory + '/context\nsh ../install.sh\nsh ../setup.sh\n'
      + 'rm -rf -- ' + directory + '\nrm -f /etc/ssh/ssh_host_*\npasswd -l root\ncloud-init clean --logs --seed --machine-id\npoweroff\n';
    // JSON is valid YAML; shell source is a file rather than interpolated into
    // shell arguments. No account credentials, SSH enrollment or daemon enter it.
    return '#cloud-config\n' + JSON.stringify({ ssh_pwauth: false, write_files: [...files,
      { path: directory + '/install.sh', permissions: '0700', content: 'set -eu\n' + input.cli.installScript },
      { path: directory + '/setup.sh', permissions: '0700', content: 'set -eu\n' + (input.setupScript ?? '') }], runcmd: [['sh', '-c', script]] });
  }
  async function build(input: { operationId: string; input: BuildInput }, waitForObservation: () => Promise<void>): Promise<BuildResult> {
    const definition = HetznerPreparationInputSchema.parse(input.input);
    let operation: Operation = { operationId: HetznerCorrelationSchema.parse(input.operationId), launch: definition.launch.choices, primaryIpIds: [] };
    try {
      const userData = cloudInit(definition);
      // REST v1's external cloud-init boundary is 32KiB, including serialized
      // files/scripts: hcloud-python servers/client.py create(user_data).
      if (new TextEncoder().encode(userData).byteLength > 32 * 1024) return { kind: 'refused', code: 'native_preparation_userdata_too_large' };
      const existing = await inspect({ nativeOperation: operation });
      if (existing.kind === 'failed') return { ...existing, kind: 'unknown' };
      if (existing.kind !== 'absent') return existing;
      const launch = operation.launch;
      const creation = decode(mini.object({ server: serverSchema, action: actionSchema }), await request('/servers', 'POST', {
        name: 'happier-prepare-' + operation.operationId, server_type: launch.serverTypeId, image: launch.imageId, location: launch.locationId,
        public_net: { enable_ipv4: launch.publicNetworking.ipv4, enable_ipv6: launch.publicNetworking.ipv6 },
        start_after_create: true, labels: { [labelKey]: operation.operationId }, user_data: userData,
      }));
      const created = creation.server;
      operation = retained(created, operation);
      if ((await waitForAction(created.id, creation.action, waitForObservation)).status === 'error') {
        return { kind: 'unknown', code: 'native_action_failed', nativeOperationRef: reference(operation) };
      }
      let observed = created;
      while (observed.status !== 'off') {
        await waitForObservation();
        const next = await server(operation);
        if (!next) return { kind: 'unknown', code: 'native_identity_not_found', nativeOperationRef: reference(operation) };
        observed = next;
      }
      operation = retained(observed, operation);
      const snapshotLabels = { [labelKey]: operation.operationId, 'happier-build-server': String(operation.serverId), 'happier-build-ips': operation.primaryIpIds.join('.') };
      const snapshot = decode(mini.object({ image: imageSchema, action: actionSchema }), await request('/servers/' + operation.serverId + '/actions/create_image', 'POST',
        { type: 'snapshot', description: 'Happier prepared guest', labels: snapshotLabels }));
      imageOperation(snapshot.image, operation);
      if ((await waitForAction(created.id, snapshot.action, waitForObservation)).status === 'error') return { kind: 'unknown', code: 'native_snapshot_failed', nativeOperationRef: reference(operation) };
      let result = classify(snapshot.image, operation);
      while (result.kind === 'pending') {
        await waitForObservation();
        const next = await image(snapshot.image.id, operation);
        if (!next) return { kind: 'unknown', code: 'native_identity_not_found', nativeOperationRef: reference(operation) };
        result = classify(next, operation);
      }
      if (result.kind !== 'ready') return { kind: 'unknown', code: 'native_snapshot_failed', nativeOperationRef: reference(operation) };
      while (!await retireServer(operation)) await waitForObservation();
      return result;
    } catch (error) { return failure(error, operation); }
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: HetznerLaunchV1 }): Promise<InspectResult> {
    let operation: Operation = 'nativeOperation' in input ? HetznerPreparationOperationSchema.parse(input.nativeOperation)
      : { operationId: HetznerCorrelationSchema.parse(input.operationId), launch: input.launch, primaryIpIds: [] };
    try {
      const found = await discover(operation);
      operation = found.operation;
      if (found.image) {
        const result = classify(found.image, operation);
        // Inspection is read-only. A complete snapshot whose billed source
        // remains must be retired by Retry's existing destroy/rebuild path.
        if (result.kind === 'ready') {
          if (await server(operation) !== null) return { kind: 'failed', code: 'native_preparation_cleanup_required', nativeOperationRef: reference(operation) };
          for (const ipId of operation.primaryIpIds) if ((await request('/primary_ips/' + ipId, 'GET', undefined, true)).kind !== 'absent') {
            return { kind: 'failed', code: 'native_preparation_cleanup_required', nativeOperationRef: reference(operation) };
          }
        }
        return result;
      }
      if (!found.server) return { kind: 'absent' };
      // A recovered shutdown without a snapshot means the interrupted build
      // must be replaced. A read never blindly reissues a billable POST.
      return found.server.status === 'off' ? { kind: 'failed', code: 'native_preparation_interrupted', nativeOperationRef: reference(operation) }
        : { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) { return failure(error, operation); }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    let operation = input.artifact ? HetznerPreparedArtifactSchema.parse(input.artifact) : HetznerPreparationOperationSchema.parse(input.nativeOperation);
    try {
      const found = await discover(operation);
      operation = { ...operation, ...found.operation };
      if (input.artifact && found.image && input.artifact.imageId !== found.image.id) throw new HetznerNativeError('native_identity_mismatch');
      const nativeImage = input.artifact ? await image(input.artifact.imageId, operation) : found.image;
      if (nativeImage) {
        await request('/images/' + nativeImage.id, 'DELETE', undefined, true);
        if (await image(nativeImage.id, operation) !== null) return { kind: 'pending', nativeOperationRef: reference(operation) };
      }
      return await retireServer(operation) ? { kind: 'confirmed' } : { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) {
      if (error instanceof HetznerNativeError && ['native_identity_mismatch', 'native_identity_ambiguous', 'native_authorization_failed'].includes(error.code)) return { kind: 'refused', code: error.code };
      return failure(error, operation);
    }
  }
  return { build, inspect, destroy };
}
