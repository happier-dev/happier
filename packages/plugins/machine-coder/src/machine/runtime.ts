import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { CoderCliUnavailable } from './cliPrerequisite.js';
import { prepareCoderConnection } from './connection.js';
import { createCoderClient } from './nativeClient.js';
import { createCoderTransport } from './transport.js';
import { CONTRIBUTION, DEPENDENCY_ID, type CoderResource, type ROLE_SCHEMAS } from './schemas.js';

export async function coderRuntime(context: PluginInvocationContext) {
  const connection = await prepareCoderConnection(context.services.connectedAccounts, context.services.http, context.signal);
  const client = createCoderClient({ request: connection.request, signal: context.signal, observedAt: context.invokedAtMs,
    waitForObservation: () => context.services.machineProvisioners.waitForNativeObservation() });
  async function transport() {
    const status = await context.services.managedServices.dependencies.status(DEPENDENCY_ID, { signal: context.signal });
    if ((status.state !== 'ready' && status.state !== 'updateAvailable') || !status.executable) throw new CoderCliUnavailable(connection.endpoint);
    return createCoderTransport({ ...connection, exec: context.services.exec, executable: status.executable, signal: context.signal });
  }
  return { ...client,
    async check() {
      await client.check();
      try { await transport(); return { available: true }; }
      catch (error) { if (error instanceof CoderCliUnavailable) return error.checkResult; throw error; }
    },
    async exec(value: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>) {
      const resource = await client.guest(value.resource);
      return (await transport()).exec({ ...value, resource });
    },
    async stream(value: ReturnType<typeof ROLE_SCHEMAS.streamInput.parse>) {
      const resource = await client.guest(value.resource);
      return (await transport()).stream({ ...value, resource });
    },
    async putFile(value: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>) {
      const resource = await client.guest(value.resource);
      return (await transport()).putFile({ ...value, resource });
    },
    async bootstrap(value: CoderResource) {
      const resource = await client.guest(value);
      const result = await (await transport()).exec({ resource, allowWake: false,
        argv: ['sh', '-c', 'printf "%s\\n" "$HOME"'] });
      if (!('stdoutBase64' in result) || result.termination.requestedBy.kind !== 'none'
        || result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) throw new PluginError({ code: 'native_boot_unconfirmed' });
      const homeDir = Buffer.from(result.stdoutBase64, 'base64').toString('utf8').trimEnd();
      if (!homeDir.startsWith('/') || homeDir.includes('\0') || homeDir.includes('\n')) throw new PluginError({ code: 'native_boot_unconfirmed' });
      return { kind: 'native' as const, transport: { contributionRef: CONTRIBUTION, schemaVersion: 1 },
        guestHome: { homeDir, happyHomeDir: homeDir.replace(/\/$/, '') + '/.happier', daemonStartup: 'native-process' as const } };
    },
  };
}
