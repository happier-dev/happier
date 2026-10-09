import { Buffer } from 'node:buffer';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  defineMachineProvisionerSchemas,
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerNativeExecResultV1Schema, MachineProvisionerObservationV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerPutFileResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createLimaSdkExecutor } from './machine/nativeExecutor.js';
import { createLimaProvider, LIMA_DEPENDENCY_ID, LIMA_PLUGIN_ID, LIMA_PROVISIONER_ID, LIMA_QEMU_DEPENDENCY_IDS } from './machine/provider.js';
import { LimaLaunchSchema, LimaResourceSchema } from './machine/schemas.js';

export const LIMA_ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: LimaLaunchSchema, resource: LimaResourceSchema });
const processAccess = 'lima-process';
const actionDefaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: [processAccess] } as const;

function errorCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'lima_unavailable';
}

async function provider(context: PluginInvocationContext) {
  // Checking never installs or mutates a managed dependency. Executable identity
  // is resolved by the public dependency owner, never a host-specific path.
  const status = await context.services.managedServices.dependencies.status(LIMA_DEPENDENCY_ID, { signal: context.signal });
  if ((status.state !== 'ready' && status.state !== 'updateAvailable') || !status.executable) {
    throw Object.assign(new Error('declared native Lima executable is unavailable'), { code: 'lima_unavailable' });
  }
  return createLimaProvider(createLimaSdkExecutor({ exec: context.services.exec, executable: status.executable, signal: context.signal }), context.invokedAtMs,
    async (dependencyId) => {
      const tool = await context.services.managedServices.dependencies.status(dependencyId, { signal: context.signal });
      return (tool.state === 'ready' || tool.state === 'updateAvailable') && tool.executable !== undefined;
    });
}

function decodePrivateBytes(value: string) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw Object.assign(new Error('invalid private byte encoding'), { code: 'invalid_request' });
  return bytes;
}

export const LIMA_MACHINE_PROVISIONER = {
  title: 'Lima', icon: 'server', resourceKind: 'lima-vm', schemaVersion: 1,
  launchSchema: LimaLaunchSchema.jsonSchema, resourceSchema: LimaResourceSchema.jsonSchema,
  platforms: ['darwin', 'linux'],
  prerequisites: [{ kind: 'managedDependency', id: LIMA_DEPENDENCY_ID }],
  billing: { location: 'local', stoppedBilling: 'not-billed' },
  retention: { supportedIntents: ['start', 'stop', 'delete'] },
  actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const LIMA_PLUGIN = definePlugin({
  id: LIMA_PLUGIN_ID, version: '0.0.0', displayName: 'Lima Machines',
  description: 'Managed local Lima guests using native, private bootstrap IO.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [{ id: processAccess, capability: 'process',
    reason: 'Operate the exact reviewed native Lima resource.',
    scope: { executables: [{ kind: 'managedDependency', id: LIMA_DEPENDENCY_ID }] },
  }], optional: [] },
  managedDependencies: { [LIMA_DEPENDENCY_ID]: {
    id: LIMA_DEPENDENCY_ID, title: 'Lima', description: 'Native Lima 2.x executable.', executable: 'limactl',
    sources: [{ kind: 'system', executableNames: ['limactl'], versionArguments: ['--version'] }],
  }, [LIMA_QEMU_DEPENDENCY_IDS.x86_64]: {
    id: LIMA_QEMU_DEPENDENCY_IDS.x86_64, title: 'QEMU x86-64', executable: 'qemu-system-x86_64',
    sources: [{ kind: 'system', executableNames: ['qemu-system-x86_64'], versionArguments: ['--version'] }],
  }, [LIMA_QEMU_DEPENDENCY_IDS.aarch64]: {
    id: LIMA_QEMU_DEPENDENCY_IDS.aarch64, title: 'QEMU AArch64', executable: 'qemu-system-aarch64',
    sources: [{ kind: 'system', executableNames: ['qemu-system-aarch64'], versionArguments: ['--version'] }],
  }, 'qemu-img': {
    id: 'qemu-img', title: 'QEMU disk image tool', executable: 'qemu-img',
    sources: [{ kind: 'system', executableNames: ['qemu-img'], versionArguments: ['--version'] }],
  } },
  machineProvisioners: { [LIMA_PROVISIONER_ID]: LIMA_MACHINE_PROVISIONER },
  actions: {
    check: {
      ...actionDefaults, title: 'Check Lima availability', dangerLevel: 'safe',
      inputSchema: LIMA_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
      async run(_input, context) {
        try { return await (await provider(context)).check(); }
        catch (error) { return { available: false, code: errorCode(error) }; }
      },
    },
    acquire: {
      ...actionDefaults, title: 'Acquire Lima guest', dangerLevel: 'writesLocal',
      confirmation: { title: 'Create this Lima guest?', body: 'This creates the reviewed VM in the selected Lima storage.' },
      inputSchema: LIMA_ROLE_SCHEMAS.acquireInput, resultSchema: LIMA_ROLE_SCHEMAS.acquireResult,
      async run(input, context) {
        try { return await (await provider(context)).acquire(input.launch); }
        catch (error) { return { kind: 'unknown' as const,
          recovery: { reference: `${input.launch.store}/${input.launch.instance}`, reason: errorCode(error) } }; }
      },
    },
    bootstrap: {
      ...actionDefaults, title: 'Resolve private Lima bootstrap transport', dangerLevel: 'writesLocal',
      confirmation: { title: 'Prepare this Lima guest for Happier?', body: 'Allow Happier to use the private native transport for this managed guest.' },
      inputSchema: LIMA_ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
      async run(input, context) { return (await provider(context)).bootstrap(input.resource); },
    },
    inspect: {
      ...actionDefaults, title: 'Inspect Lima guest', dangerLevel: 'safe',
      inputSchema: LIMA_ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).inspect(input.resource); }
        catch (error) { return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: errorCode(error) }; }
      },
    },
    power: {
      ...actionDefaults, title: 'Change Lima guest power', dangerLevel: 'writesLocal',
      confirmation: { title: 'Change this Lima guest’s power?', body: 'This starts or stops the exact managed VM. Stop does not preserve running memory.' },
      inputSchema: LIMA_ROLE_SCHEMAS.powerInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        if (input.intent !== 'start' && input.intent !== 'stop') return { kind: 'refused' as const, code: 'LIMA_UNSUPPORTED_INTENT' };
        try { return await (await provider(context)).power(input.resource, input.intent); }
        catch (error) { return { kind: 'unknown' as const, code: errorCode(error) }; }
      },
    },
    destroy: {
      ...actionDefaults, title: 'Delete exact Lima guest', dangerLevel: 'destructive',
      confirmation: { title: 'Delete this Lima guest?', body: 'This permanently removes the exact managed VM and its disk from the recorded storage.' },
      inputSchema: LIMA_ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerPowerResultV1Schema,
      async run(input, context) {
        try { return await (await provider(context)).destroy(input.resource); }
        catch (error) { return { kind: 'unknown' as const, code: errorCode(error) }; }
      },
    },
    exec: {
      ...actionDefaults, title: 'Execute private Lima bootstrap IO', dangerLevel: 'writesLocal',
      confirmation: { title: 'Run Happier setup in this Lima guest?', body: 'This runs the admitted setup command inside the exact managed guest.' },
      inputSchema: LIMA_ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
      async run(input, context) {
        const result = await (await provider(context)).exec(input.resource, input.argv,
          input.inputBase64 === undefined ? undefined : decodePrivateBytes(input.inputBase64));
        return { termination: result.process.termination, stdoutBase64: Buffer.from(result.process.stdout).toString('base64'),
          stderrBase64: Buffer.from(result.process.stderr).toString('base64'),
          stdoutTruncated: result.process.stdoutTruncated, stderrTruncated: result.process.stderrTruncated };
      },
    },
    'put-file': {
      ...actionDefaults, title: 'Write private Lima bootstrap file', dangerLevel: 'writesLocal',
      confirmation: { title: 'Write this Lima guest’s setup file?', body: 'This writes the private setup payload to its reviewed path inside the exact managed guest.' },
      inputSchema: LIMA_ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
      async run(input, context) {
        try {
          const result = await (await provider(context)).putFile(input.resource, input.guestPath, decodePrivateBytes(input.bytesBase64),
            input.mode === undefined ? undefined : `0${input.mode.toString(8).padStart(3, '0')}`);
          return result.kind === 'written' ? { kind: 'confirmed' as const } : { kind: 'unknown' as const };
        } catch (error) {
          const code = errorCode(error);
          return { kind: code === 'invalid_request' || code === 'LIMA_INVALID_PATH' || code === 'resource_mismatch'
            ? 'refused' as const : 'unknown' as const, code };
        }
      },
    },
  },
});

export const PLUGIN_MANIFEST = LIMA_PLUGIN.manifest;
