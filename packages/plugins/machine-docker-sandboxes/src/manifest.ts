import { Buffer } from 'node:buffer';
import { machinePresentationLabel, machineCheckPresentation, DOCKER_SANDBOXES_UI_TRANSLATION_BUNDLES } from './ui/translations.js';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerNativeExecResultV1Schema, MachineProvisionerObservationV1Schema,
  MachineProvisionerOptionsResultV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerPutFileResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createDockerSandboxesProvider, DOCKER_SANDBOXES_DEPENDENCY_ID, DOCKER_SANDBOXES_PLUGIN_ID,
  DOCKER_SANDBOXES_PROVISIONER_ID } from './machine/provider.js';
import { DOCKER_SANDBOXES_ROLE_SCHEMAS, DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS, DockerSandboxesLaunchV1Schema, DockerSandboxesResourceV1Schema } from './machine/schemas.js';

const processAccess = 'docker-sandboxes-process';
const actionDefaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: [processAccess] } as const;
function errorCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'docker_sandbox_unavailable';
}
async function provider(context: PluginInvocationContext) {
  // A system declaration uses the shared dependency owner. No vendor download,
  // license grant, install or native daemon effect occurs during discovery.
  const status = await context.services.managedServices.dependencies.status(DOCKER_SANDBOXES_DEPENDENCY_ID, { signal: context.signal });
  if ((status.state !== 'ready' && status.state !== 'updateAvailable') || !status.executable) {
    throw Object.assign(new Error('native Docker Sandboxes executable unavailable'), { code: 'docker_sandbox_unavailable' });
  }
  if (status.version !== '0.46.0') {
    throw Object.assign(new Error('native Docker Sandboxes version is not qualified'), { code: 'docker_sandbox_version_unqualified' });
  }
  return createDockerSandboxesProvider(context.services.exec, status.executable, context.invokedAtMs, context.signal);
}
function privateBytes(value: string) {
  return Buffer.from(value, 'base64');
}

export const DOCKER_SANDBOXES_MACHINE_PROVISIONER = {
  title: 'Docker Sandboxes', icon: 'cube', resourceKind: 'docker-sandbox', schemaVersion: 1,
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: DockerSandboxesLaunchV1Schema.jsonSchema, resourceSchema: DockerSandboxesResourceV1Schema.jsonSchema, resourceIdPath: 'sandboxName',
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [{ kind: 'managedDependency', id: DOCKER_SANDBOXES_DEPENDENCY_ID }],
  billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: DockerSandboxesResourceV1Schema.jsonSchema, action: 'reconcile' },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const DOCKER_SANDBOXES_PLUGIN = definePlugin({
  id: DOCKER_SANDBOXES_PLUGIN_ID, version: '0.0.0', displayName: 'Docker Sandbox Machines',
  description: 'Native local Docker Sandboxes with retained names and private bootstrap IO.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [{ id: processAccess, capability: 'process', reason: 'Operate the exact reviewed Docker Sandbox.',
    scope: { executables: [{ kind: 'managedDependency', id: DOCKER_SANDBOXES_DEPENDENCY_ID }] },
  }], optional: [] },
  managedDependencies: { [DOCKER_SANDBOXES_DEPENDENCY_ID]: {
    id: DOCKER_SANDBOXES_DEPENDENCY_ID, title: 'Docker Sandboxes', executable: 'sbx',
    description: 'User-installed sbx v0.46.0 under the Docker subscription license.',
    sources: [{ kind: 'system', executableNames: ['sbx'], versionArguments: ['version'] }],
  } },
  ui: { translations: DOCKER_SANDBOXES_UI_TRANSLATION_BUNDLES },
  machineProvisioners: { [DOCKER_SANDBOXES_PROVISIONER_ID]: DOCKER_SANDBOXES_MACHINE_PROVISIONER },
  actions: {
    check: { ...actionDefaults, title: 'Check Docker Sandboxes', dangerLevel: 'safe',
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try { return machineCheckPresentation(await (await provider(context)).check()); }
        catch (error) { return machineCheckPresentation({ available: false, code: errorCode(error) }); }
      },
    },
    options: { ...actionDefaults, title: 'Discover Docker Sandbox templates', dangerLevel: 'safe',
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerOptionsResultV1Schema,
      async run(_input, context) { return (await provider(context)).options(); },
    },
    acquire: { ...actionDefaults, title: 'Create Docker Sandbox', dangerLevel: 'writesLocal',
      confirmation: { title: 'Create Docker Sandbox', confirmLabel: 'Create' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.acquireInput, resultSchema: DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS.result,
      async run(input, context) {
        // Dependency refusal is pre-effect; native uncertainty is preserved by
        // the adapter with its preselected managed-row-derived resource name.
        let native: Awaited<ReturnType<typeof provider>>;
        try { native = await provider(context); }
        catch { return { kind: 'rejected' as const, code: 'provider_unavailable' as const }; }
        return native.acquire(input.launch, input.managedId);
      },
    },
    reconcile: { ...actionDefaults, title: 'Recover exact Docker Sandbox', dangerLevel: 'safe',
      inputSchema: DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS.input, resultSchema: DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS.result,
      async run(input, context) {
        return (await provider(context)).reconcile(input); },
    },
    bootstrap: { ...actionDefaults, title: 'Resolve private Docker Sandbox bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare Docker Sandbox bootstrap' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return (await provider(context)).bootstrap(input.resource); },
    },
    inspect: { ...actionDefaults, title: 'Inspect Docker Sandbox', dangerLevel: 'safe',
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).inspect(input.resource); }
        catch (error) { return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: errorCode(error) }; }
      },
    },
    power: { ...actionDefaults, title: 'Change Docker Sandbox power', dangerLevel: 'writesLocal',
      confirmation: { title: 'Change Docker Sandbox power' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).power(input.resource, input.intent); }
        catch (error) { return { kind: 'unknown' as const, code: errorCode(error) }; }
      },
    },
    destroy: { ...actionDefaults, title: 'Delete exact Docker Sandbox', dangerLevel: 'destructive',
      confirmation: { title: 'Delete Docker Sandbox', body: 'Deletes the sandbox and all of its retained files.', confirmLabel: 'Delete' },
      inputSchema: DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS.destroyInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).destroy(input); }
        catch (error) { return { kind: 'unknown' as const, code: errorCode(error) }; }
      },
    },
    exec: { ...actionDefaults, title: 'Execute private Docker Sandbox bootstrap', dangerLevel: 'writesLocal',
      confirmation: { title: 'Execute Docker Sandbox bootstrap' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) {
        const result = await (await provider(context)).exec(input.resource, input.argv,
          input.inputBase64 === undefined ? undefined : privateBytes(input.inputBase64));
        return { termination: result.termination, stdoutBase64: Buffer.from(result.stdout).toString('base64'),
          stderrBase64: Buffer.from(result.stderr).toString('base64'), stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
      },
    },
    'put-file': { ...actionDefaults, title: 'Write private Docker Sandbox bootstrap file', dangerLevel: 'writesLocal',
      confirmation: { title: 'Write Docker Sandbox bootstrap file' },
      inputSchema: DOCKER_SANDBOXES_ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).putFile(input.resource, input.guestPath, privateBytes(input.bytesBase64), input.mode); }
        catch (error) { return { kind: 'unknown' as const, code: errorCode(error) }; }
      },
    },
  },
});

export const PLUGIN_MANIFEST = DOCKER_SANDBOXES_PLUGIN.manifest;
