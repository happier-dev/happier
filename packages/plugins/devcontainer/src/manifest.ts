import { Buffer } from 'node:buffer';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerNativeExecResultV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema,
  MachineProvisionerOptionsResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createDevcontainerProvider, DEVCONTAINER_PLUGIN_ID, DEVCONTAINER_PROVISIONER_ID } from './machine/provider.js';
import { DevcontainerLaunchSchema, DevcontainerResourceSchema, DevcontainerReviewQuerySchema, DevcontainerNativeOperationSchema } from './machine/schemas.js';
import { readDevcontainerEffectReview, readDevcontainerNativeEnvironment } from './machine/effectReview.js';

export const DEVCONTAINER_ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: DevcontainerLaunchSchema, resource: DevcontainerResourceSchema });
export const DEVCONTAINER_RECONCILIATION_SCHEMAS = defineMachineProvisionerReconciliationSchemas({ launch: DevcontainerLaunchSchema, resource: DevcontainerResourceSchema,
  nativeOperation: DevcontainerNativeOperationSchema });
const processAccess = 'devcontainer-process';
const devcontainerDependencyId = 'devcontainer-cli';
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: [processAccess] } as const;
function code(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'provider_unavailable'; }
async function provider(context: PluginInvocationContext) {
  return createDevcontainerProvider(await nativeTools(context));
}
async function nativeTools(context: PluginInvocationContext) {
  const statuses = await Promise.all(['docker', devcontainerDependencyId].map(id => context.services.managedServices.dependencies.status(id, { signal: context.signal })));
  const [docker, devcontainer] = statuses;
  if (!docker || !devcontainer || (docker.state !== 'ready' && docker.state !== 'updateAvailable')
    || (devcontainer.state !== 'ready' && devcontainer.state !== 'updateAvailable') || !docker.executable || !devcontainer.executable) {
    throw Object.assign(new Error('Devcontainer prerequisites are unavailable'), { code: 'provider_unavailable' });
  }
  return { exec: context.services.exec, docker: docker.executable,
    devcontainer: devcontainer.executable, signal: context.signal, observedAt: context.invokedAtMs,
    environment: readDevcontainerNativeEnvironment() };
}
function bytes(value: string) {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw Object.assign(new Error('Invalid private bytes'), { code: 'invalid_request' });
  return decoded;
}
export const DEVCONTAINER_MACHINE_PROVISIONER = {
  title: 'Devcontainer', icon: 'cube', resourceKind: 'devcontainer', schemaVersion: 1,
  launchSchema: DevcontainerLaunchSchema.jsonSchema, resourceSchema: DevcontainerResourceSchema.jsonSchema,
  platforms: ['darwin', 'linux', 'win32'],
  prerequisites: [{ kind: 'managedDependency', id: 'docker' }, { kind: 'managedDependency', id: devcontainerDependencyId }],
  billing: { location: 'local', stoppedBilling: 'not-billed' },
  retention: { supportedIntents: ['start', 'stop', 'delete', 'rebuild'] },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy', rebuild: 'rebuild' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: DevcontainerNativeOperationSchema.jsonSchema, action: 'reconcile' },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const DEVCONTAINER_PLUGIN = definePlugin({
  id: DEVCONTAINER_PLUGIN_ID, version: '0.0.0', displayName: 'Devcontainer Machines',
  description: 'Ordinary managed children on their physical Docker controller.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [{ id: processAccess, capability: 'process', reason: 'Realize and manage the reviewed Devcontainer on this controller.',
    scope: { executables: [{ kind: 'managedDependency', id: 'docker' }, { kind: 'managedDependency', id: devcontainerDependencyId }] } }], optional: [] },
  managedDependencies: {
    docker: { id: 'docker', title: 'Docker', executable: 'docker', sources: [{ kind: 'system', executableNames: ['docker'], versionArguments: ['--version'] }] },
    [devcontainerDependencyId]: { id: devcontainerDependencyId, title: 'Devcontainer CLI', executable: 'devcontainer', sources: [{ kind: 'system', executableNames: ['devcontainer'], versionArguments: ['--version'] }] },
  },
  machineProvisioners: { [DEVCONTAINER_PROVISIONER_ID]: DEVCONTAINER_MACHINE_PROVISIONER },
  actions: {
    options: { ...defaults, title: 'Review Devcontainer effects', dangerLevel: 'safe',
      inputSchema: DevcontainerReviewQuerySchema, resultSchema: MachineProvisionerOptionsResultV1Schema,
      inputHints: { fields: [
        { path: 'workspaceFolder', title: 'Workspace folder on the controller', widget: 'text', required: true },
        { path: 'configPath', title: 'Devcontainer configuration path on the controller', widget: 'text', required: true },
      ] },
      async run(input, context) {
        const reviewed = await readDevcontainerEffectReview(await nativeTools(context), input);
        return { choices: [{ id: reviewed.launch.configPath, title: 'Devcontainer', available: true, ...reviewed }] };
      } },
    check: { ...defaults, title: 'Check Devcontainer availability', dangerLevel: 'safe', inputSchema: DEVCONTAINER_ROLE_SCHEMAS.checkInput,
      resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) { try { return await (await provider(context)).check(); } catch (error) { return { available: false, code: code(error) }; } } },
    acquire: { ...defaults, title: 'Realize Devcontainer child', dangerLevel: 'writesLocal', inputSchema: DEVCONTAINER_ROLE_SCHEMAS.acquireInput,
      confirmation: { title: 'Create Devcontainer', body: 'Runs the reviewed host and child setup hooks on this controller.', confirmLabel: 'Create' },
      resultSchema: DEVCONTAINER_RECONCILIATION_SCHEMAS.result,
      async run(input, context) { try { return await (await provider(context)).acquire(input.launch, input.managedId ?? ''); }
        catch (error) { return { kind: 'unknown' as const, recovery: { reference: input.launch.configPath, reason: code(error) } }; } } },
    bootstrap: { ...defaults, title: 'Resolve private child enrollment transport', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare Devcontainer enrollment' },
      inputSchema: DEVCONTAINER_ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return (await provider(context)).bootstrap(input.resource); } },
    inspect: { ...defaults, title: 'Inspect retained Devcontainer', dangerLevel: 'safe', inputSchema: DEVCONTAINER_ROLE_SCHEMAS.resourceInput,
      resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) { try { return await (await provider(context)).inspect(input.resource); }
        catch (error) { return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: code(error) }; } } },
    power: { ...defaults, title: 'Change Devcontainer power', dangerLevel: 'writesLocal', inputSchema: DEVCONTAINER_ROLE_SCHEMAS.powerInput,
      confirmation: { title: 'Change Devcontainer power' },
      resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (input.intent !== 'start' && input.intent !== 'stop') return { kind: 'refused' as const, code: 'unsupported_intent' };
        try { return await (await provider(context)).power(input.resource, input.intent); }
        catch (error) { return { kind: 'unknown' as const, code: code(error) }; }
      } },
    destroy: { ...defaults, title: 'Delete exact Devcontainer installation', dangerLevel: 'destructive',
      confirmation: { title: 'Delete Devcontainer', body: 'Deletes this container, preserving bind-mounted sources and named volumes.', confirmLabel: 'Delete' },
      inputSchema: DEVCONTAINER_RECONCILIATION_SCHEMAS.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (!('resource' in input)) return { kind: 'refused' as const, code: 'native_cleanup_unavailable' };
        try { return await (await provider(context)).destroy(input.resource); }
        catch (error) { return { kind: 'unknown' as const, code: code(error) }; } } },
    rebuild: { ...defaults, title: 'Rebuild exact Devcontainer installation', dangerLevel: 'destructive',
      confirmation: { title: 'Rebuild Devcontainer', body: 'Replaces this container and runs the reviewed host and child setup hooks.', confirmLabel: 'Rebuild' },
      inputSchema: DEVCONTAINER_ROLE_SCHEMAS.rebuildInput, resultSchema: DEVCONTAINER_ROLE_SCHEMAS.rebuildResult,
      async run(input, context) { return (await provider(context)).rebuild(input.resource, input.reviewedEffectDigest); } },
    reconcile: { ...defaults, title: 'Observe Devcontainer replacement', dangerLevel: 'safe',
      inputSchema: DEVCONTAINER_RECONCILIATION_SCHEMAS.input, resultSchema: DEVCONTAINER_RECONCILIATION_SCHEMAS.result,
      async run(input, context) {
        if (!('nativeOperation' in input)) return { kind: 'rejected' as const, code: 'provider_unavailable' as const };
        return (await provider(context)).reconcile(input.nativeOperation); } },
    exec: { ...defaults, title: 'Execute private child bootstrap IO', dangerLevel: 'writesLocal',
      confirmation: { title: 'Execute Devcontainer enrollment' },
      inputSchema: DEVCONTAINER_ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) {
        const result = await (await provider(context)).exec(input.resource, input.argv,
          input.inputBase64 === undefined ? undefined : bytes(input.inputBase64));
        return { termination: result.termination, stdoutBase64: Buffer.from(result.stdout).toString('base64'),
          stderrBase64: Buffer.from(result.stderr).toString('base64'), stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
      } },
    'put-file': { ...defaults, title: 'Write private child bootstrap payload', dangerLevel: 'writesLocal',
      confirmation: { title: 'Write Devcontainer enrollment payload' },
      inputSchema: DEVCONTAINER_ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) { return (await provider(context)).putFile(input.resource, input.guestPath, bytes(input.bytesBase64), input.mode); } },
  },
});
export const PLUGIN_MANIFEST = DEVCONTAINER_PLUGIN.manifest;
