import { defineProtocolNumber, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { Agent37LaunchSchema, Agent37PreparedNameSchema, PREPARED_NAME_HASH_LENGTH, PREPARED_NAME_PREFIX, reference, type Agent37Launch } from './schemas.js';
import { KINDS } from './kinds.js';
import { createAgent37BuildContext } from './buildContext.js';

const closed = { policy: 'closed' } as const;
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
const revision = defineProtocolNumber({ integer: true, minimum: 1 });
const digest = defineProtocolString({ pattern: '^sha256:[a-f0-9]{64}$' });
const buildId = defineProtocolString({ pattern: '^tb_[a-z0-9]+$' });
export const Agent37PreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(Agent37LaunchSchema);
export const Agent37PreparedArtifactSchema = defineProtocolObject({ name: Agent37PreparedNameSchema, revision, imageDigest: digest, launch: Agent37LaunchSchema }, closed);
export const Agent37PreparationOperationSchema = defineProtocolObject({ name: Agent37PreparedNameSchema, launch: Agent37LaunchSchema, buildId: buildId.optional() }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: Agent37PreparationInputSchema,
  launch: Agent37LaunchSchema, artifact: Agent37PreparedArtifactSchema, nativeOperation: Agent37PreparationOperationSchema });
type Input = ProtocolSchemaOutput<typeof Agent37PreparationInputSchema>;
type Artifact = ProtocolSchemaOutput<typeof Agent37PreparedArtifactSchema>;
type Operation = ProtocolSchemaOutput<typeof Agent37PreparationOperationSchema>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const publishedSchema = defineProtocolObject({ name: text, revision, image_digest: digest }, open);
const templateSchema = defineProtocolObject({ name: text, scope: text, revision, image_digest: digest }, open);
const baseSchema = defineProtocolObject({ name: text, scope: text, image_ref: text }, open);
const createdSchema = defineProtocolObject({ id: buildId, name: text, status: text, upload_url: text }, open);
const buildErrorSchema = defineProtocolObject({ code: defineProtocolString({ pattern: '^[a-z][a-z0-9_]*$' }) }, open);
const buildSchema = defineProtocolObject({ id: buildId, name: text, status: text, template: publishedSchema.optional(), error: buildErrorSchema.optional() }, open);
type NativeBuild = ProtocolSchemaOutput<typeof buildSchema>;
const API = 'https://api.agent37.com/v1';
class NativeError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}
const invalid = () => new NativeError('agent37_template_invalid_response');
async function operationName(operationId: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.parse(operationId)));
  return PREPARED_NAME_PREFIX + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, PREPARED_NAME_HASH_LENGTH);
}

// https://www.agent37.com/docs/agents-api/templates (observed 2026-11-16).
// Build from the selected clean system image, never an enrolled instance.
export function createAgent37PreparationClient(request: typeof fetch, signal?: AbortSignal, options: { storageFetch?: typeof fetch } = {}) {
  const templatePath = (operation: { name: string }) => '/templates/' + encodeURIComponent(operation.name);
  async function http(path: string, method = 'GET', body?: unknown) {
    signal?.throwIfAborted();
    const response = await request(API + path, { method, signal, redirect: 'error', headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok && response.status !== 404) throw new NativeError(response.status === 401 || response.status === 403 ? 'credential_unavailable' : 'agent37_http_' + response.status, response.status);
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    if (!response.ok) throw new NativeError('agent37_http_' + response.status, response.status);
    try { return await response.json() as unknown; } catch { throw invalid(); }
  }
  function failure(error: unknown, operation: Operation, fallback: string) {
    return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const,
      code: error instanceof NativeError ? error.code : fallback, nativeOperationRef: reference(operation) }));
  }
  async function template(operation: Operation, expected?: Pick<Artifact, 'revision' | 'imageDigest'>) {
    const response = await http(templatePath(operation));
    if (response.status === 404) return null;
    const parsed = templateSchema.safeParse(await json(response));
    if (!parsed.success) throw invalid();
    const native = parsed.data;
    if (native.name !== operation.name || native.scope !== 'workspace'
      || expected !== undefined && (native.revision !== expected.revision || native.image_digest !== expected.imageDigest)) {
      throw new NativeError('agent37_template_identity_mismatch');
    }
    return native;
  }
  async function readBuild(operation: Operation): Promise<NativeBuild | null> {
    if (!operation.buildId) return null;
    const response = await http('/template-builds/' + encodeURIComponent(operation.buildId));
    if (response.status === 404) return null;
    const parsed = buildSchema.safeParse(await json(response));
    if (!parsed.success) throw invalid();
    if (parsed.data.id !== operation.buildId || parsed.data.name !== operation.name) throw new NativeError('agent37_template_identity_mismatch');
    return parsed.data;
  }
  function ready(native: ProtocolSchemaOutput<typeof templateSchema>, operation: Operation): InspectResult {
    return { kind: 'ready', artifact: reference({ name: native.name, revision: native.revision, imageDigest: native.image_digest,
      launch: { ...operation.launch, template: native.name + '@' + native.revision } }) };
  }
  async function build(input: { operationId: string; input: Input }): Promise<BuildResult> {
    const definition = Agent37PreparationInputSchema.parse(input.input);
    let operation: Operation = { name: await operationName(input.operationId), launch: definition.launch.choices };
    let dispatched = false;
    try {
      // Preparation always starts from the canonical clean base, including when
      // a prior prepared launch was supplied. Workspace build images have no OCI
      // image_ref and must never become a second composition/selection path.
      const selected = KINDS.find(kind => kind.id === operation.launch.kind)!;
      const base = baseSchema.safeParse(await json(await http('/templates/' + encodeURIComponent(selected.template))));
      if (!base.success || base.data.name !== selected.template || base.data.scope !== 'system' || /\s/.test(base.data.image_ref)) {
        return { kind: 'refused', code: 'agent37_template_base_unavailable' };
      }
      const directory = '/tmp/.happier-preparation';
      const copies = definition.cli.files.map(file => 'COPY ' + JSON.stringify([file.path, directory + '/' + file.path]) + '\n').join('');
      const command = ['sh', '-c', 'set -e\nif [ -n "$1" ]; then trap \'rm -rf -- "$1"\' EXIT; cd -- "$1"; fi\nsh -c "$2"\nchmod -R a+rX /opt/happier\nsh -c "$3"\n',
        'happier-build', definition.cli.files.length ? directory : '', definition.cli.installScript, definition.setupScript ?? ''];
      const install = copies + 'RUN ' + JSON.stringify(command) + '\n';
      // Run the install as root, then restore the system image's runtime user.
      const dockerfile = 'FROM --platform=linux/amd64 ' + base.data.image_ref + '\n' + (selected.preparationBaseUser
        ? 'USER root\n' + install + 'USER ' + selected.preparationBaseUser + '\n'
        : install);
      const context = await createAgent37BuildContext(dockerfile, definition.cli.files);
      dispatched = true;
      const created = createdSchema.safeParse(await json(await http('/template-builds', 'POST', { name: operation.name, size_bytes: context.length })));
      if (!created.success) throw invalid();
      if (created.data.name !== operation.name || created.data.status !== 'created') throw new NativeError('agent37_template_identity_mismatch');
      operation = { ...operation, buildId: created.data.id };
      // This signed URL is a temporary upload credential. Never put it in the
      // retained operation or send the Account bearer to its storage origin.
      const uploaded = await (options.storageFetch ?? fetch)(created.data.upload_url, { method: 'PUT', signal, redirect: 'error',
        headers: { 'content-type': 'application/gzip' }, body: context });
      if (!uploaded.ok) throw new NativeError('agent37_context_upload_unavailable', uploaded.status);
      const started = await json(await http('/template-builds/' + encodeURIComponent(operation.buildId!) + '/start', 'POST'));
      const parsed = defineProtocolObject({ id: buildId, status: text }, open).safeParse(started);
      if (!parsed.success || parsed.data.id !== operation.buildId || parsed.data.status !== 'building') throw invalid();
      return { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) {
      if (!dispatched || !operation.buildId && error instanceof NativeError && error.status !== undefined
        && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409) {
        return projectMachineProvisionerActionFailure(error, () => ({ kind: 'refused', code: error instanceof NativeError ? error.code : 'agent37_context_invalid' }));
      }
      return failure(error, operation, 'agent37_build_unconfirmed');
    }
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: Agent37Launch }): Promise<InspectResult> {
    const operation: Operation = 'nativeOperation' in input ? Agent37PreparationOperationSchema.parse(input.nativeOperation)
      : { name: await operationName(input.operationId), launch: input.launch };
    try {
      const native = await readBuild(operation);
      if (native?.status === 'building' || native?.status === 'ingesting') return { kind: 'pending', nativeOperationRef: reference(operation) };
      if (native?.status === 'failed' || native?.status === 'created') return { kind: 'failed',
        code: native.status === 'failed' && native.error ? 'agent37_' + native.error.code : 'agent37_build_' + native.status,
        nativeOperationRef: reference(operation) };
      if (native && native.status !== 'succeeded') throw new NativeError('agent37_build_state_unsupported');
      const expected = native?.template;
      if (native && (!expected || expected.name !== operation.name)) throw invalid();
      const published = await template(operation, expected && { revision: expected.revision, imageDigest: expected.image_digest });
      if (published) return ready(published, operation);
      // No native list/cancel/delete build API exists. With a lost build id, 404
      // on the template cannot disprove a build still running/publishing later.
      return native?.status === 'succeeded' ? { kind: 'absent' }
        : { kind: 'unknown', code: 'agent37_build_identity_unconfirmed', nativeOperationRef: reference(operation) };
    } catch (error) { return failure(error, operation, 'agent37_template_read_unconfirmed'); }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    const artifact = input.artifact && Agent37PreparedArtifactSchema.parse(input.artifact);
    const operation: Operation = artifact ? { name: artifact.name, launch: artifact.launch } : Agent37PreparationOperationSchema.parse(input.nativeOperation);
    try {
      const build = artifact ? null : await readBuild(operation);
      if (build?.status === 'building' || build?.status === 'ingesting') return { kind: 'pending', nativeOperationRef: reference(operation) };
      if (build && !['created', 'failed', 'succeeded'].includes(build.status)) throw new NativeError('agent37_build_state_unsupported');
      const expected = artifact ?? (build?.template && { revision: build.template.revision, imageDigest: build.template.image_digest });
      if (build?.template && build.template.name !== operation.name) throw new NativeError('agent37_template_identity_mismatch');
      const before = await template(operation, expected);
      if (before === null) {
        return artifact || build ? { kind: 'confirmed' } : { kind: 'unknown', code: 'agent37_build_identity_unconfirmed', nativeOperationRef: reference(operation) };
      }
      await http(templatePath(operation), 'DELETE');
      // Confirms workspace-template absence only. Existing instances keep their
      // image; private image purge after their deletion requires vendor support.
      return await template(operation) === null ? { kind: 'confirmed' } : { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) {
      if (error instanceof NativeError && error.code === 'agent37_template_identity_mismatch') return { kind: 'refused', code: error.code };
      return failure(error, operation, 'agent37_template_delete_unconfirmed');
    }
  }
  return { build, inspect, destroy };
}
