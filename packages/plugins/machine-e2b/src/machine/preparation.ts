import { isMachineProvisionerCreateRefusal, buildMachineProvisionerPreparationInstallScript, quoteMachineProvisionerShellArgument as quote } from '@happier-dev/plugin-sdk/machine-provisioners';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';
import { E2bNativeError, projectE2bNativeFailure } from './nativeFailure.js';
import { E2bLaunchSchema, reference, type E2bLaunch } from './schemas.js';
import { createE2bBuildContext } from './buildContext.js';

const closed = { policy: 'closed' } as const;
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
export const E2B_PREPARATION_HOME = '/opt/happier';
export const E2bPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(E2bLaunchSchema);
export const E2bPreparedArtifactSchema = defineProtocolObject({ name: text, templateId: text, buildId: text, launch: E2bLaunchSchema }, closed);
export const E2bPreparationOperationSchema = defineProtocolObject({ name: text, launch: E2bLaunchSchema, templateId: text.optional(), buildId: text.optional() }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({
  input: E2bPreparationInputSchema, launch: E2bLaunchSchema, artifact: E2bPreparedArtifactSchema, nativeOperation: E2bPreparationOperationSchema,
});
type BuildInput = ProtocolSchemaOutput<typeof E2bPreparationInputSchema>;
type Operation = ProtocolSchemaOutput<typeof E2bPreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof E2bPreparedArtifactSchema>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const templateFields = { templateID: text, buildID: defineProtocolString(), names: defineProtocolArray(text), public: boolean };
const templateSchema = defineProtocolObject(templateFields, open);
const detailSchema = defineProtocolObject({ ...templateFields, builds: defineProtocolArray(defineProtocolObject({ buildID: text }, open)) }, open);
const reservationSchema = defineProtocolObject({ templateID: text, buildID: text, names: defineProtocolArray(text), public: boolean }, open);
const aliasSchema = defineProtocolObject({ templateID: text, public: boolean }, open);
const statusSchema = defineProtocolObject({ templateID: text, buildID: text, status: text }, open);
const uploadSchema = defineProtocolObject({ present: boolean, url: text.optional(),
  headers: defineProtocolObject({}, { policy: 'additive-open/preserve', additionalProperties: defineProtocolString() }).optional() }, open);
const named = (names: readonly string[], name: string) => names.some(value => value === name || value.split('/').length === 2 && value.split('/')[1] === name);
class PreparationError extends E2bNativeError {
  constructor(code: string, readonly status?: number) { super({ code }); }
}

// E2B OpenAPI 0.1.0 + JS template SDK, retrieved 2026-11-16:
// https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/template/buildApi.ts
// Reserve once, upload COPY files, then start a clean fromTemplate build.
// No enrolled sandbox, vendor logs, or Account material enters the image.
export function createE2bPreparationClient(request: typeof fetch, signal?: AbortSignal) {
  async function http(path: string, method = 'GET', body?: unknown) {
    signal?.throwIfAborted();
    const response = await request('https://api.e2b.app' + path, { method, signal, redirect: 'error', headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok && response.status !== 404) throw new PreparationError('e2b_http_' + response.status, response.status);
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    if (!response.ok) throw new PreparationError('e2b_http_' + response.status, response.status);
    try { return await response.json() as unknown; }
    catch { throw new PreparationError('e2b_template_invalid_response'); }
  }
  function owned(value: ProtocolSchemaOutput<typeof templateSchema>, operation: Operation) {
    if (value.public || !named(value.names, operation.name)
      || operation.templateId !== undefined && value.templateID !== operation.templateId) throw new PreparationError('e2b_template_identity_mismatch');
    return value;
  }
  async function resolve(operation: Operation): Promise<Operation | null> {
    if (operation.templateId) return operation;
    // This exact team-scoped alias lookup also works before the first ready
    // build. It avoids enumerating unrelated templates to recover one operation.
    const response = await http('/templates/aliases/' + encodeURIComponent(operation.name));
    if (response.status === 404) return null;
    const parsed = aliasSchema.safeParse(await json(response));
    if (!parsed.success) throw new PreparationError('e2b_template_invalid_response');
    if (parsed.data.public) throw new PreparationError('e2b_template_identity_mismatch');
    return { ...operation, templateId: parsed.data.templateID };
  }
  async function read(operation: Operation) {
    const resolved = await resolve(operation);
    if (!resolved) return null;
    const response = await http('/templates/' + encodeURIComponent(resolved.templateId!));
    if (response.status === 404) return null;
    const parsed = detailSchema.safeParse(await json(response));
    if (!parsed.success) throw new PreparationError('e2b_template_invalid_response');
    const template = parsed.data;
    owned(template, resolved);
    const buildId = resolved.buildId ?? (template.builds.length === 1 ? template.builds[0]!.buildID : undefined);
    if (!buildId || !template.builds.some(build => build.buildID === buildId)) throw new PreparationError('e2b_template_identity_mismatch');
    return { template, operation: { ...resolved, buildId } };
  }
  function failure(error: unknown, operation: Operation, fallback: string, mayOwn = true) {
    return projectE2bNativeFailure(error, (): { kind: 'refused'; code: string }
      | { kind: 'unknown'; code: string; nativeOperationRef: ReturnType<typeof reference<Operation>> } => {
      const code = error instanceof E2bNativeError ? error.code
        : error instanceof Error && (error.message === 'credential_unavailable' || error.message === 'provider_unavailable') ? error.message : fallback;
      if (!mayOwn && code === 'credential_unavailable') return { kind: 'refused', code };
      if (error instanceof PreparationError && (error.code === 'e2b_template_identity_mismatch'
        || !mayOwn && isMachineProvisionerCreateRefusal(error.status, [409]))) return { kind: 'refused', code };
      return { kind: 'unknown', code, nativeOperationRef: reference(operation) };
    });
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: E2bLaunch }): Promise<InspectResult> {
    let operation: Operation = 'nativeOperation' in input ? E2bPreparationOperationSchema.parse(input.nativeOperation)
      : { name: 'happier-prepared-' + text.parse(input.operationId), launch: input.launch };
    try {
      const native = await read(operation);
      if (!native) return { kind: 'absent' };
      operation = native.operation;
      const response = await http('/templates/' + encodeURIComponent(operation.templateId!) + '/builds/' + encodeURIComponent(operation.buildId!) + '/status?limit=0');
      // A missing build is not proof that its allocated template is gone.
      const parsed = statusSchema.safeParse(await json(response));
      if (!parsed.success) throw new PreparationError('e2b_template_invalid_response');
      const status = parsed.data;
      if (status.templateID !== operation.templateId || status.buildID !== operation.buildId) throw new PreparationError('e2b_template_identity_mismatch');
      switch (status.status) {
        case 'ready':
          if (native.template.buildID !== operation.buildId) return { kind: 'unknown', code: 'e2b_template_launch_unconfirmed', nativeOperationRef: reference(operation) };
          return { kind: 'ready', artifact: reference({ name: operation.name, templateId: operation.templateId!, buildId: operation.buildId!,
            launch: { ...operation.launch, templateId: operation.templateId! } }) };
        case 'building': return { kind: 'pending', nativeOperationRef: reference(operation) };
        // infra template_build_status.go: waiting means reserved but not started.
        // No producer advances that state after an interrupted reservation.
        case 'waiting': return { kind: 'failed', code: 'e2b_template_build_not_started', nativeOperationRef: reference(operation) };
        case 'error': return { kind: 'failed', code: 'e2b_template_build_failed', nativeOperationRef: reference(operation) };
        default: return { kind: 'unknown', code: 'e2b_template_state_unsupported', nativeOperationRef: reference(operation) };
      }
    } catch (error) {
      const result = await failure(error, operation, 'e2b_template_read_unconfirmed');
      return result.kind === 'refused' ? { kind: 'unknown', code: result.code, nativeOperationRef: reference(operation) } : result;
    }
  }
  async function build(input: { operationId: string; input: BuildInput }): Promise<BuildResult> {
    const definition = E2bPreparationInputSchema.parse(input.input);
    let operation: Operation = { name: 'happier-prepared-' + text.parse(input.operationId), launch: definition.launch.choices };
    let mayOwn = false;
    try {
      // Reservation itself can allocate even if its response is lost.
      const response = await http('/v3/templates', 'POST', { name: operation.name });
      mayOwn = true;
      const parsed = reservationSchema.safeParse(await json(response));
      if (!parsed.success) throw new PreparationError('e2b_template_invalid_response');
      owned(parsed.data, operation);
      operation = { ...operation, templateId: parsed.data.templateID, buildId: parsed.data.buildID };
      const directory = '/tmp/happier-preparation-' + encodeURIComponent(input.operationId);
      const steps: { type: string; args: string[]; filesHash?: string }[] = [];
      if (definition.cli.files.length) {
        const context = createE2bBuildContext(definition.cli.files);
        const upload = uploadSchema.safeParse(await json(await http('/templates/' + encodeURIComponent(operation.templateId!) + '/files/' + context.hash)));
        if (!upload.success) throw new PreparationError('e2b_template_invalid_response');
        if (!upload.data.present) {
          if (!upload.data.url) throw new PreparationError('e2b_template_invalid_response');
          signal?.throwIfAborted();
          // Vendor-issued signed storage URL: no API-key materialization here.
          // A byte body supplies its exact Content-Length, as required by S3.
          const uploaded = await fetch(upload.data.url, { method: 'PUT', redirect: 'error', signal, headers: upload.data.headers, body: context.bytes });
          if (!uploaded.ok) throw new PreparationError('e2b_template_upload_http_' + uploaded.status, uploaded.status);
        }
        steps.push({ type: 'COPY', args: ['.', directory + '/', 'root', ''], filesHash: context.hash });
      }
      const script = 'set -eu\nmkdir -p ' + quote(directory) + '\ntrap ' + quote('rm -rf -- ' + quote(directory)) + ' EXIT\n'
        + buildMachineProvisionerPreparationInstallScript({ cli: definition.cli, stageDirectory: directory, setupScript: definition.setupScript });
      steps.push({ type: 'RUN', args: ['sh -c ' + quote(script), 'root'] });
      const started = await http('/v2/templates/' + encodeURIComponent(operation.templateId!) + '/builds/' + encodeURIComponent(operation.buildId!), 'POST', {
        fromTemplate: operation.launch.templateId, steps,
      });
      if (!started.ok) throw new PreparationError('e2b_http_' + started.status, started.status);
      return { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) {
      // A lost reservation is recoverable by name even before IDs were received.
      // Refuse only a definite rejection before allocation; retain every other outcome.
      if (mayOwn && error instanceof PreparationError && error.code === 'e2b_template_identity_mismatch') {
        return { kind: 'unknown', code: error.code, nativeOperationRef: reference(operation) };
      }
      return failure(error, operation, 'e2b_template_build_unconfirmed', mayOwn);
    }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    const artifact = input.artifact && E2bPreparedArtifactSchema.parse(input.artifact);
    let operation: Operation = artifact ? { name: artifact.name, templateId: artifact.templateId, buildId: artifact.buildId, launch: artifact.launch }
      : E2bPreparationOperationSchema.parse(input.nativeOperation);
    try {
      const before = await read(operation);
      if (!before) return { kind: 'confirmed' };
      operation = before.operation;
      await http('/templates/' + encodeURIComponent(operation.templateId!), 'DELETE');
      return await read(operation) === null ? { kind: 'confirmed' } : { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) { return failure(error, operation, 'e2b_template_delete_unconfirmed'); }
  }
  return { build, inspect, destroy };
}
