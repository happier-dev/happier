import { posix, win32 } from 'node:path';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { CRABBOX_DEPENDENCY_ID } from './constants.js';
import { CrabboxDependencyUnavailable } from './provider.js';

/** Same binary and isolated environment for ordinary leases and native-owned builders. */
async function nativeCommand(context: PluginInvocationContext) {
  const dependency = await context.services.managedServices.dependencies.status(CRABBOX_DEPENDENCY_ID, { signal: context.signal });
  if ((dependency.state !== 'ready' && dependency.state !== 'updateAvailable') || !dependency.executable) throw new CrabboxDependencyUnavailable();
  const executable = dependency.executable;
  return (stateRoot: string, environment?: Readonly<Record<string, string>>) => {
    const toolEnvironment = Object.fromEntries(['PATH', 'Path', 'SystemRoot'].flatMap(key => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }));
    const paths = win32.isAbsolute(stateRoot) && !posix.isAbsolute(stateRoot) ? win32 : posix;
    const env = { ...toolEnvironment, ...environment, XDG_STATE_HOME: stateRoot,
      CRABBOX_CONFIG: paths.join(stateRoot, 'happier-isolated.yaml'), GIT_CEILING_DIRECTORIES: paths.dirname(stateRoot) };
    return (args: readonly string[], stdin?: Uint8Array) => context.services.exec.run({ executable, args, cwd: stateRoot, env,
      ...(stdin ? { stdin } : {}) }, { signal: context.signal });
  };
}

/** A clean builder uses Crabbox's own fresh SSH key under its private native
 * state; it cannot borrow an enrolled resource's admitted bootstrap key. */
export async function createCrabboxNativeStateExecution(context: PluginInvocationContext, stateRoot: string,
  environment?: Readonly<Record<string, string>>) {
  return (await nativeCommand(context))(stateRoot, environment);
}

/** One host-owned credential delivery path for ordinary managed resources. */
export async function createCrabboxNativeExecution(context: PluginInvocationContext) {
  const command = await nativeCommand(context);
  return async function withNative<T>(leaseId: string,
    effect: (run: (args: readonly string[], stdin?: Uint8Array) => Promise<PluginProcessResult>) => Promise<T>,
    environment?: Readonly<Record<string, string>>) {
    const relativePath = `native/crabbox/testboxes/${leaseId}/id_ed25519`;
    return context.services.machineProvisioners.withBootstrapCredentialFile({ relativePath }, async credential => {
      const paths = win32.isAbsolute(credential.path) && !posix.isAbsolute(credential.path) ? win32 : posix;
      const stateRoot = paths.dirname(paths.dirname(paths.dirname(paths.dirname(credential.path))));
      if (!paths.isAbsolute(credential.path) || credential.path !== paths.join(stateRoot, 'crabbox', 'testboxes', leaseId, 'id_ed25519')) {
        throw Object.assign(new Error('Crabbox native credential delivery unavailable'), { code: 'credential_unavailable' });
      }
      return effect(command(stateRoot, environment));
    });
  };
}
