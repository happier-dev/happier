import type { InteractiveSystemTaskContext } from '../interactiveTaskKinds.js';
import type { RemoteBootstrapMachineParams } from '../kinds/remoteSshBootstrapMachineKind.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import { prepareDedicatedDaemonBootstrap, type DedicatedDaemonBootstrapExec } from './dedicatedDaemonBootstrap.js';
import { buildDedicatedDaemonAccountCommand, DEDICATED_DAEMON_INSTALL_HOME } from './remoteBootstrapCommandBuilder.js';

/** Installation placement is selected once here; platform adapters supply only IO. */
export type RemoteCliInstallation = Readonly<{
  remoteHomeDir?: string;
  daemonUsername?: 'happier';
}>;

export type RemoteCliInstallTransport = Readonly<{
  exec: DedicatedDaemonBootstrapExec;
  install: (placement: RemoteCliInstallation) => Promise<Readonly<{ binaryPath: string }>>;
}>;

type BootstrapContext = Pick<InteractiveSystemTaskContext, 'taskId' | 'emit' | 'prompt'>;
export type PrepareManagedDedicatedBootstrap = (input: Readonly<{
  binaryPath: string;
  exec: DedicatedDaemonBootstrapExec;
  context: BootstrapContext;
  channel: 'stable' | 'preview' | 'dev';
}>) => Promise<void>;

/** The same admitted bootstrap and installer lifecycle serves every SSH transport. */
export async function installRemoteCli(input: Readonly<{
  channel: 'stable' | 'preview' | 'dev';
  signal?: AbortSignal;
  transport: RemoteCliInstallTransport;
  bootstrap?: Readonly<{
    parsed: Omit<RemoteBootstrapMachineParams, 'ssh'> & { ssh?: RemoteBootstrapMachineParams['ssh'] };
    enrolledMachineId?: string;
    context?: BootstrapContext;
    createPromptId: () => string;
    prepareManagedBootstrap?: PrepareManagedDedicatedBootstrap;
  }>;
}>): Promise<void> {
  const { transport, bootstrap } = input;
  const identity = bootstrap?.parsed.enrollmentIdentity;
  let prepare: ((binaryPath: string) => Promise<void>) | undefined;
  if (bootstrap && identity?.kind === 'dedicatedDaemonUser' && !bootstrap.enrolledMachineId) {
    const context = bootstrap.context;
    if (!context) throw new SystemTaskExecutionError('managed_enrollment_unavailable', 'Dedicated enrollment requires its admitted bootstrap owner.');
    const parsed = bootstrap.parsed;
    if (parsed.managedEnrollment) {
      const managed = bootstrap.prepareManagedBootstrap;
      if (!managed) throw new SystemTaskExecutionError('managed_enrollment_unavailable', 'Managed enrollment requires its retained bootstrap owner.');
      prepare = binaryPath => managed({ binaryPath, exec: transport.exec, context, channel: input.channel });
    } else {
      if (!context.taskId || !parsed.ssh) throw new SystemTaskExecutionError('managed_enrollment_unavailable', 'Standalone enrollment requires its admitted task.');
      const task = { taskId: context.taskId, enrollmentIdentity: identity, sshTarget: parsed.ssh.target,
        ...(parsed.ssh.port !== undefined ? { sshPort: parsed.ssh.port } : {}),
        ...(parsed.homeTarget?.homeServerIdentityId ? { homeServerIdentityId: parsed.homeTarget.homeServerIdentityId } : {}),
        relayUrl: parsed.relay.relayUrl };
      prepare = binaryPath => prepareDedicatedDaemonBootstrap({ binaryPath, task, channel: input.channel,
        exec: transport.exec, emit: context.emit, prompt: context.prompt, signal: input.signal,
        createPromptId: bootstrap.createPromptId });
    }
    const platform = await transport.exec({ command: 'uname -s', signal: input.signal });
    if (platform.status !== 0 || platform.stdout.trim() !== 'Linux') {
      throw new SystemTaskExecutionError('dedicated_identity_unsupported', 'The dedicated daemon identity requires a supported Linux user service.');
    }
    const account = await transport.exec({ command: buildDedicatedDaemonAccountCommand(), signal: input.signal });
    if (account.status !== 0) throw new SystemTaskExecutionError('dedicated_identity_unconfirmed', 'The dedicated daemon account could not be prepared.');
  }
  const installed = await transport.install(identity?.kind === 'dedicatedDaemonUser' ? {
    remoteHomeDir: DEDICATED_DAEMON_INSTALL_HOME, daemonUsername: 'happier',
  } : {});
  if (prepare) await prepare(installed.binaryPath);
}
