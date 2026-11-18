import { createHash } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { projectMachineProvisionerActionFailure as projectExternalActionFailure, type MachineProvisionerObservationV1, type MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { coderCredentialUnavailable } from './connection.js';
import { BILLING, CoderOperationSchema, CoderResourceSchema, reference, RECONCILIATION, type CoderAcquireOperation, type CoderDeleteOperation, type CoderLaunch, type CoderResource } from './schemas.js';

// Coder v2.39.0 codersdk/{workspaces,workspacebuilds}.go. Decode consumed
// fields at the HTTP boundary; native response additions remain compatible.
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const nullableText = defineProtocolUnion([defineProtocolString(), defineProtocolLiteral(null)]);
const userSchema = defineProtocolObject({ id: text, username: text }, open);
const templateVersionSchema = defineProtocolObject({ id: text, template_id: text, organization_id: text }, open);
const agentSchema = defineProtocolObject({ id: text, name: text, status: text }, open);
const buildSchema = defineProtocolObject({ id: text, workspace_id: text, template_version_id: text, transition: text, status: text,
  job: defineProtocolObject({ status: text }, open),
  resources: defineProtocolArray(defineProtocolObject({ agents: defineProtocolArray(agentSchema).nullable().optional() }, open)).nullable().optional(),
}, open);
const workspaceSchema = defineProtocolObject({ id: text, owner_id: text, owner_name: text, organization_id: text, template_id: text, name: text,
  latest_build: buildSchema, dormant_at: nullableText.optional(),
}, open);
const buildFailed = (build: ReturnType<typeof buildSchema.parse>) => build.job.status === 'failed' || build.job.status === 'canceled' || build.status === 'failed' || build.status === 'canceled';
type Workspace = ReturnType<typeof workspaceSchema.parse>;
type Acquisition = ReturnType<typeof RECONCILIATION.result.parse>;
type Destruction = ReturnType<typeof RECONCILIATION.destroyResult.parse>;
class CoderNativeError extends PluginError {
  constructor(code: string) { super({ code }); }
}
const fail = (code: string): never => { throw new CoderNativeError(code); };
export const coderFailureCode = (error: unknown) => error instanceof CoderNativeError ? error.code : 'provider_unavailable';
// Native failures retain operation-specific recovery after an effect. If one
// escapes before admission, the host still receives the canonical PluginError.
function projectCoderFailure<T>(error: unknown, fallback: () => T | PromiseLike<T>): T | PromiseLike<T> {
  return error instanceof CoderNativeError ? fallback() : projectExternalActionFailure(error, fallback);
}
// Coder's workspace-name boundary is 32 characters. A stable managed row name
// allows owner-qualified recovery even when the create response was lost.
export const coderWorkspaceName = (managedId: string) => 'hm-' + createHash('sha256').update(managedId).digest('hex').slice(0, 29);
const pending = (operation: CoderAcquireOperation): Acquisition => ({ kind: 'pending', nativeOperationRef: reference(operation) });
const unknown = (operation: CoderAcquireOperation, reason: string): Acquisition => ({ kind: 'unknown', recovery: { reference: operation.workspaceId ?? `${operation.ownerId}/${operation.workspaceName}`, reason } });
const resourceFor = (operation: CoderAcquireOperation, native: Workspace): CoderResource => ({ workspaceId: native.id, ownerId: native.owner_id, ownerName: native.owner_name,
  workspaceName: native.name, organizationId: native.organization_id, templateId: native.template_id, agentName: operation.launch.agentName, managedId: operation.managedId });
const powerOf = (native: Workspace) => native.latest_build.status === 'running' ? 'running' as const : native.latest_build.status === 'stopped' ? 'stopped' as const : 'unknown' as const;
const inProgress = (status: string) => status === 'pending' || status === 'starting' || status === 'stopping' || status === 'deleting' || status === 'canceling';

export function createCoderClient(input: { request: (path: string, init?: RequestInit) => Promise<Response>; signal: AbortSignal; observedAt: number; waitForObservation: () => Promise<void> }) {
  let userPromise: Promise<ReturnType<typeof userSchema.parse>> | undefined;
  async function request(path: string, method = 'GET', body?: unknown, acceptMissing = false) {
    input.signal.throwIfAborted();
    const response = await input.request('/api/v2' + path, { method, redirect: 'error', signal: input.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 401) throw coderCredentialUnavailable();
    if (response.status === 403) throw new PluginError({ code: 'permission_denied' });
    if (response.status === 404 && acceptMissing) return null;
    if (!response.ok) fail(response.status >= 400 && response.status < 500 ? 'invalid_request' : 'provider_unavailable');
    try { return await response.json() as unknown; } catch { return fail('coder_invalid_response'); }
  }
  async function qualifyTemplateVersion(selection: Pick<CoderLaunch, 'templateVersionId' | 'templateId' | 'organizationId'>) {
    const version = templateVersionSchema.parse(await request('/templateversions/' + encodeURIComponent(selection.templateVersionId)));
    if (version.id !== selection.templateVersionId || version.template_id !== selection.templateId || version.organization_id !== selection.organizationId) throw new PluginError({ code: 'resource_mismatch' });
    return version;
  }
  function user() {
    return userPromise ??= request('/users/me').then(value => {
      const parsed = userSchema.safeParse(value);
      return parsed.success ? parsed.data : fail('coder_invalid_response');
    });
  }
  async function principal(ownerId: string) {
    if ((await user()).id !== ownerId) throw new PluginError({ code: 'permission_denied' });
  }
  function parseWorkspace(value: unknown) {
    const parsed = workspaceSchema.safeParse(value);
    return parsed.success ? parsed.data : fail('coder_invalid_response');
  }
  function matches(native: Workspace, expected: Pick<CoderResource, 'ownerId' | 'organizationId' | 'templateId'>) {
    return native.owner_id === expected.ownerId && native.organization_id === expected.organizationId && native.template_id === expected.templateId;
  }
  async function read(resource: CoderResource) {
    await principal(resource.ownerId);
    const value = await request('/workspaces/' + encodeURIComponent(resource.workspaceId) + '?include_deleted=true', 'GET', undefined, true);
    if (value === null) return null;
    const native = parseWorkspace(value);
    if (native.id !== resource.workspaceId || !matches(native, resource)) fail('coder_resource_mismatch');
    return native.latest_build.status === 'deleted' ? null : native;
  }
  async function operationFor(launch: CoderLaunch, managedId: string): Promise<CoderAcquireOperation> {
    const owner = await user();
    return { kind: 'acquire', launch, managedId, ownerId: owner.id, ownerName: owner.username, workspaceName: coderWorkspaceName(managedId) };
  }
  async function observeAcquisition(operation: CoderAcquireOperation, native: Workspace): Promise<Acquisition> {
    if (!matches(native, { ownerId: operation.ownerId, organizationId: operation.launch.organizationId, templateId: operation.launch.templateId })
      || native.name !== operation.workspaceName || native.latest_build.template_version_id !== operation.launch.templateVersionId
      || operation.workspaceId !== undefined && native.id !== operation.workspaceId) return unknown(operation, 'coder_resource_mismatch');
    const retained = { ...operation, workspaceId: native.id, buildId: operation.buildId ?? native.latest_build.id };
    if (native.latest_build.status === 'deleted') return { kind: 'rejected', code: 'managed_not_found' };
    // Allocation is real even when an agent is disconnected or Start failed.
    // Bind only after native creation settles; the shared bootstrap owns guest IO.
    if (!inProgress(native.latest_build.status)) return { kind: 'bound', resource: { ...reference(resourceFor(retained, native)), origin: 'created' as const } };
    return pending(retained);
  }
  async function observeRetainedAcquisition(operation: CoderAcquireOperation): Promise<Acquisition> {
    await principal(operation.ownerId);
    const path = operation.workspaceId ? '/workspaces/' + encodeURIComponent(operation.workspaceId)
      : '/users/' + encodeURIComponent(operation.ownerId) + '/workspace/' + encodeURIComponent(operation.workspaceName);
    const value = await request(path + '?include_deleted=true', 'GET', undefined, true);
    // A missing name after uncertain create does not prove the POST never
    // arrived; no second allocation or absence declaration is authorized.
    if (value === null) return unknown(operation, 'coder_acquisition_unconfirmed');
    return observeAcquisition(operation, parseWorkspace(value));
  }
  async function recover(raw: unknown): Promise<Acquisition> {
    const operation = CoderOperationSchema.parse(raw);
    if (operation.kind === 'delete') return { kind: 'bound', resource: reference(operation.resource) };
    try { return await observeRetainedAcquisition(operation); }
    catch (error) { return projectCoderFailure(error, () => unknown(operation, coderFailureCode(error))); }
  }
  async function buildObservation(resource: CoderResource, buildId: string) {
    const value = await request('/workspacebuilds/' + encodeURIComponent(buildId));
    const parsed = buildSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== buildId || parsed.data.workspace_id !== resource.workspaceId) return fail('coder_resource_mismatch');
    return parsed.data;
  }
  async function submitBuild(resource: CoderResource, transition: 'start' | 'stop' | 'delete') {
    const value = await request('/workspaces/' + encodeURIComponent(resource.workspaceId) + '/builds', 'POST', { transition });
    const parsed = buildSchema.safeParse(value);
    if (!parsed.success || parsed.data.workspace_id !== resource.workspaceId || parsed.data.transition !== transition) return fail('coder_invalid_response');
    return parsed.data;
  }
  async function inspect(resource: CoderResource): Promise<MachineProvisionerObservationV1> {
    try {
      const native = await read(resource);
      return native ? { observedAt: input.observedAt, availability: 'present', power: powerOf(native), storage: 'unknown', billing: BILLING,
        ...(native.dormant_at ? { reason: 'coder_dormant' } : {}) }
        : { observedAt: input.observedAt, availability: 'absent', storage: 'lost', billing: BILLING };
    } catch (error) { return projectCoderFailure(error, () => ({ observedAt: input.observedAt, availability: 'unavailable', power: 'unknown', reason: coderFailureCode(error) })); }
  }
  async function cleanup(raw: unknown): Promise<ReturnType<typeof RECONCILIATION.cleanupResult.parse>> {
    const operation = CoderOperationSchema.parse(raw);
    if (operation.kind !== 'delete') return { kind: 'unknown', code: 'coder_acquisition_unconfirmed' };
    try {
      const native = await read(operation.resource);
      if (!native) return { kind: 'confirmed' };
      const observed = operation.buildId ? await buildObservation(operation.resource, operation.buildId) : native.latest_build;
      if (observed.transition === 'delete' && buildFailed(observed)) return { kind: 'unknown', code: 'coder_build_failed' };
      return { kind: 'unknown', code: 'coder_delete_pending' };
    } catch (error) { return projectCoderFailure(error, () => ({ kind: 'unknown', code: coderFailureCode(error) })); }
  }
  async function destroy(value: ReturnType<typeof RECONCILIATION.destroyInput.parse>): Promise<Destruction> {
    let resource: CoderResource;
    if ('nativeOperation' in value) {
      if (value.nativeOperation.kind === 'delete') {
        const observed = await cleanup(value.nativeOperation);
        if (observed.kind === 'confirmed') return { kind: 'confirmed' };
        if (observed.kind === 'unknown' && observed.code !== 'coder_delete_pending') return observed;
        return { kind: 'accepted', nativeOperationRef: reference(value.nativeOperation) };
      }
      const recovered = await recover(value.nativeOperation);
      if (recovered.kind === 'rejected' && recovered.code === 'managed_not_found') return { kind: 'confirmed' };
      if (recovered.kind === 'pending') {
        const operation = CoderOperationSchema.parse(recovered.nativeOperationRef.value);
        // A known allocated workspace may be deleted even while its create
        // build runs. Coder itself owns whether it can admit that transition.
        if (operation.kind !== 'acquire' || !operation.workspaceId) return { kind: 'unknown', code: 'coder_acquisition_unconfirmed' };
        resource = { workspaceId: operation.workspaceId, ownerId: operation.ownerId, ownerName: operation.ownerName, workspaceName: operation.workspaceName,
          organizationId: operation.launch.organizationId, templateId: operation.launch.templateId, agentName: operation.launch.agentName, managedId: operation.managedId };
      } else if (recovered.kind === 'bound') resource = CoderResourceSchema.parse(recovered.resource.value);
      else return { kind: 'unknown', code: 'coder_acquisition_unconfirmed' };
    } else resource = value.resource;
    let operation: CoderDeleteOperation = { kind: 'delete', resource };
    let issued = false;
    try {
      const native = await read(resource);
      if (!native) return { kind: 'confirmed' };
      if (native.latest_build.transition === 'delete') {
        operation = { ...operation, buildId: native.latest_build.id };
        return { kind: 'accepted', nativeOperationRef: reference(operation) };
      }
      issued = true;
      const build = await submitBuild(resource, 'delete');
      operation = { ...operation, buildId: build.id };
      return { kind: 'accepted', nativeOperationRef: reference(operation) };
    } catch (error) { return projectCoderFailure(error, () => issued && coderFailureCode(error) !== 'invalid_request'
      ? { kind: 'accepted', nativeOperationRef: reference(operation) } : { kind: issued ? 'refused' : 'unknown', code: coderFailureCode(error) }); }
  }
  return {
    request, read, operationFor, recover, inspect, destroy, cleanup, qualifyTemplateVersion,
    async check() { await user(); return { available: true }; },
    async acquire(launch: CoderLaunch, managedId: string): Promise<Acquisition> {
      await qualifyTemplateVersion(launch);
      const operation = await operationFor(launch, managedId);
      let retained = operation;
      try {
        const value = await request('/users/' + encodeURIComponent(operation.ownerId) + '/workspaces', 'POST', {
          name: operation.workspaceName, template_version_id: launch.templateVersionId,
          rich_parameter_values: launch.parameterValues, ...(launch.presetId ? { template_version_preset_id: launch.presetId } : {}),
        });
        const native = parseWorkspace(value);
        retained = { ...operation, workspaceId: native.id, buildId: native.latest_build.id };
        let result = await observeAcquisition(retained, native);
        while (result.kind === 'pending') {
          await input.waitForObservation(); input.signal.throwIfAborted();
          result = await observeRetainedAcquisition(retained);
        }
        return result;
      } catch (error) { return projectCoderFailure(error, () => coderFailureCode(error) === 'invalid_request'
        ? { kind: 'rejected', code: 'invalid_request' } : pending(retained)); }
    },
    async power(resource: CoderResource, intent: string): Promise<MachineProvisionerPowerResultV1> {
      input.signal.throwIfAborted();
      if (intent !== 'start' && intent !== 'stop') return { kind: 'refused', code: 'invalid_request' };
      let issued = false;
      try {
        let native = await read(resource);
        if (!native) return { kind: 'refused', code: 'managed_not_found' };
        if (intent === 'start' && native.dormant_at) return { kind: 'refused', code: 'coder_dormant' };
        if (powerOf(native) === (intent === 'start' ? 'running' : 'stopped')) return { kind: 'confirmed' };
        issued = true;
        // Retry observes an already admitted matching build; it never starts
        // another build merely because the earlier reply was uncertain.
        const build = native.latest_build.transition === intent && inProgress(native.latest_build.status)
          ? native.latest_build : await submitBuild(resource, intent);
        while (true) {
          const observed = await buildObservation(resource, build.id);
          if (observed.transition !== intent) fail('coder_resource_mismatch');
          native = await read(resource);
          if (!native) return { kind: 'unknown', code: 'managed_not_found' };
          if (buildFailed(observed)) return { kind: 'unknown', code: 'coder_build_failed' };
          if (observed.job.status === 'succeeded' && powerOf(native) === (intent === 'start' ? 'running' : 'stopped')) return { kind: 'confirmed' };
          await input.waitForObservation(); input.signal.throwIfAborted();
        }
      } catch (error) { input.signal.throwIfAborted(); return projectCoderFailure(error, () => ({ kind: issued ? 'unknown' : 'refused', code: coderFailureCode(error) })); }
    },
    async guest(resource: CoderResource) {
      const native = await read(resource);
      if (!native) throw new PluginError({ code: 'managed_not_found' });
      if (native.dormant_at) throw new PluginError({ code: 'coder_dormant' });
      if (powerOf(native) !== 'running') throw new PluginError({ code: 'managed_power_required' });
      const agents = (native.latest_build.resources ?? []).flatMap(item => item.agents ?? []).filter(agent => agent.name === resource.agentName);
      if (agents.length !== 1) throw new PluginError({ code: 'coder_agent_unavailable' });
      return { ...resource, ownerName: native.owner_name, workspaceName: native.name };
    },
  };
}
export type CoderClient = ReturnType<typeof createCoderClient>;
