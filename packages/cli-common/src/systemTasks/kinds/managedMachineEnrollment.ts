import type { ResolvedHomeTarget } from '../../homeTarget/homeTarget.js';
import type { ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';
import type { MachineProvisionerProcessConfigV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { InteractiveSystemTaskContext, InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import { createRemoteNativeBootstrapMachineTaskKind } from './remoteSshBootstrapMachineKind.js';
import type { PrepareManagedDedicatedBootstrap } from '../ssh/installRemoteCli.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ManagedEnrollmentCorrelationV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedBootstrapCarrierV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { ManagedMachineBootstrapPromptV1Schema, type ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import { parseSshTrustPromptData } from '@happier-dev/protocol/system/tasks/promptPayloadContracts';
import { buildRemoteHappierInvocationCommand, buildDedicatedDaemonInvocationCommand } from '../ssh/remoteBootstrapCommandBuilder.js';
import { normalizeRemoteReleaseArch, normalizeRemoteReleaseOs, resolveRemoteInstalledFirstPartyBinaryPath } from '../ssh/remoteFirstPartyInstallPath.js';
import { installRemoteCli as installSharedRemoteCli } from '../ssh/installRemoteCli.js';
import { prepareDedicatedDaemonBootstrap } from '../ssh/dedicatedDaemonBootstrap.js';
import { resolveRemoteSelfDownloadFirstPartyInstallPlan, executeRemoteSelfDownloadFirstPartyInstallPlan } from '../ssh/remoteSelfDownloadFirstPartyInstallCommand.js';
import { createHappierJsonExecutorFromTextRunner } from '../executors/happierJsonExecutorFromTextRunner.js';
import { createEnrollMachineFlowExecutorFromHappierJsonExecutor } from '../executors/enrollMachineFlowExecutor.js';
import { resolveLocalHappierCommandTimeoutMs } from '../executors/happierJsonExecutorFromTextRunner.js';
import type { InteractiveSystemTaskPromptRequest } from '../interactiveTaskKinds.js';
import { parseSshKnownHostLine } from './sshKnownHostLine.js';
import { buildManagedNativeGuestCommand, startManagedNativeGuestDaemon } from '../../machines/managed/nativeBootstrap.js';

export type ManagedNativeBootstrapIO = Readonly<{
  exec(input: Readonly<{ command: string; input?: string; signal?: AbortSignal; timeoutMs?: number | null;
    onStdoutChunk?: (text: string) => void; processConfig?: MachineProvisionerProcessConfigV1 }>): Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
  putFile(input: Readonly<{ path: string; bytes: Uint8Array; signal?: AbortSignal }>): Promise<void>;
}>;

type NativeTaskOptions = Parameters<typeof createRemoteNativeBootstrapMachineTaskKind>[0];
export type ManagedNativePayloadInstallation = Readonly<{
  channel: 'stable' | 'preview' | 'dev';
  os: 'linux' | 'darwin'; arch: 'x64' | 'arm64'; home: string;
  remoteHomeDir?: string; dedicatedIdentity: boolean;
  resource: ManagedEnrollmentCorrelationV1['resource']['value'];
  signal?: AbortSignal;
  exec: ManagedNativeBootstrapIO['exec']; putFile: ManagedNativeBootstrapIO['putFile'];
  bootstrapExec: ManagedNativeBootstrapIO['exec']; cleanupExec: ManagedNativeBootstrapIO['exec'];
}>;

export type ManagedMachineEnrollmentInput = Readonly<{
  correlation: ManagedEnrollmentCorrelationV1;
  target: ResolvedHomeTarget;
  carrier: unknown;
  /** Only the retained generated bundle supplies this; scanner evidence is not trust. */
  guestHostPublicKey?: string;
  operationId?: string;
  /** Persist successful installation before ordinary Account pairing starts. */
  onInstalled?(): Promise<void>;
  /** Host-private admitted Create carrier; never part of task params or a wire input. */
  reviewedChild?: HostReviewedChildPortV1;
  signal?: AbortSignal;
  channel: 'stable' | 'preview' | 'dev';
}>;

export type ManagedMachineEnrollmentDependencies = Readonly<{
  readCurrentManagedRow(): Promise<ManagedMachineV1>;
  onEnrollmentDeadline?(deadlineMs: number, transport: 'ssh' | 'native'): void;
  native?: ManagedNativeBootstrapIO;
  createPromptId(): string;
  runTask(kind: InteractiveSystemTaskKind): Promise<Readonly<{ machineId: string }>>;
  approveLocalAuthRequest: NativeTaskOptions['approveLocalAuthRequest'];
  deliverAuthApproval?: NativeTaskOptions['deliverAuthApproval'];
  createPairingDelivery?(enrollmentAccountId: string): NativeTaskOptions['deliverAuthApproval'];
  runSshTask?(input: Readonly<{
    configuration: NativeTaskOptions['configuration'];
    reviewedChild?: HostReviewedChildPortV1;
    carrier: Extract<import('@happier-dev/protocol/machines/managed/providerFactsV1').ManagedBootstrapCarrierV1, { kind: 'ssh' }>;
    trustedHostKey?: string;
    prepareDedicatedBootstrap: PrepareManagedDedicatedBootstrap;
    deliverAuthApproval?: NativeTaskOptions['deliverAuthApproval'];
    onEnrollmentDeadline(deadlineMs: number): void;
    assertCurrent(): Promise<void>;
  }>): Promise<Readonly<{ machineId: string }>>;
  installNativePayload?(input: ManagedNativePayloadInstallation): Promise<Readonly<{ binaryPath: string }>>;
}>;

async function installNativeSelfDownload(input: ManagedNativePayloadInstallation): Promise<Readonly<{ binaryPath: string }>> {
  input.signal?.throwIfAborted();
  const plan = await resolveRemoteSelfDownloadFirstPartyInstallPlan({ componentId: 'happier-cli', channel: input.channel,
    os: input.os, arch: input.arch, remoteHomeDir: input.remoteHomeDir,
    runRemoteText: command => input.exec({ command, signal: input.signal }) });
  input.signal?.throwIfAborted();
  const result = await executeRemoteSelfDownloadFirstPartyInstallPlan({ componentId: 'happier-cli', channel: input.channel,
    remoteHomeDir: input.remoteHomeDir, plan, runRemoteText: async command => input.exec({ command, signal: input.signal }) });
  if (result.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'Native binary installation failed.');
  return { binaryPath: plan.binaryPath };
}

/** The retained operation publishes only the current question's closed, nonsecret projection. */
export function projectManagedMachineBootstrapPrompt(prompt: InteractiveSystemTaskPromptRequest): ManagedMachineBootstrapPromptV1 {
  const data = prompt.data && typeof prompt.data === 'object' && !Array.isArray(prompt.data) ? prompt.data : undefined;
  const trust = prompt.kind === 'ssh.trustHost' || prompt.kind === 'ssh.replaceHostKey'
    ? parseSshTrustPromptData(prompt.kind, prompt.data && typeof prompt.data === 'object' && !Array.isArray(prompt.data)
      && 'host' in prompt.data ? prompt.data : {})
    : null;
  const projected = ManagedMachineBootstrapPromptV1Schema.safeParse({ kind: prompt.kind, message: prompt.message, ...trust,
    ...(prompt.kind === 'administrator.establish' ? {
      promptId: data && 'promptId' in data ? data.promptId : undefined,
      administratorUsername: data && 'administratorUsername' in data ? data.administratorUsername : undefined,
    } : {}),
  });
  if (!projected.success) throw new SystemTaskExecutionError('invalid_bootstrap_prompt', 'Managed installation question is invalid.');
  return projected.data;
}

/** The shared admitted native/SSH install, ordinary enrollment and startup owner. */
export async function runManagedMachineEnrollment(input: ManagedMachineEnrollmentInput,
  deps: ManagedMachineEnrollmentDependencies): Promise<Readonly<{ machineId: string }>> {
  const correlation = ManagedEnrollmentCorrelationV1Schema.parse(input.correlation);
  const carrier = ManagedBootstrapCarrierV1Schema.parse(input.carrier);
  const onEnrollmentDeadline = (deadlineMs: number) => deps.onEnrollmentDeadline?.(deadlineMs, carrier.kind);
  if (input.target.homeServerIdentityId !== correlation.homeId || !input.target.descriptor) {
    throw new SystemTaskExecutionError('home_identity_mismatch', 'Managed enrollment requires its admitted Home descriptor.');
  }
  input.signal?.throwIfAborted();
  const row = await deps.readCurrentManagedRow();
  if (row.id !== correlation.managedId || row.homeId !== correlation.homeId
    || row.intentRevision !== correlation.expectedIntentRevision || row.creationState !== 'active' || row.archivedAt !== undefined
    || !sameStrictJsonValue(row.controller, correlation.controller)) {
    throw new SystemTaskExecutionError('enrollment_retired', 'Managed enrollment admission is no longer current.');
  }
  if (row.allocation !== 'bound' || !sameStrictJsonValue(row.resource, correlation.resource)) {
    throw new SystemTaskExecutionError('resource_mismatch', 'Managed enrollment must use the retained native identity.');
  }
  // Admission binds the retained row once; subsequent phases observe local cancellation.
  const assertCurrent = async () => { input.signal?.throwIfAborted(); };
  const enrollmentAccountId = row.enrollmentAccountId ?? row.custodianAccountId;
  const requesterEnrollment = enrollmentAccountId !== row.custodianAccountId;
  const deliverAuthApproval = requesterEnrollment
    ? deps.createPairingDelivery?.(enrollmentAccountId) ?? deps.deliverAuthApproval
    : deps.deliverAuthApproval;
  if (requesterEnrollment && !row.enrolledMachineId && !deliverAuthApproval) {
    throw new SystemTaskExecutionError('admission_unavailable', 'Requester enrollment requires its owning Account pairing delivery.');
  }
  const dedicatedIdentity = row.enrollmentIdentity?.kind === 'dedicatedDaemonUser' ? row.enrollmentIdentity : undefined;
  const nativeGuestHome = carrier.kind === 'native' && !dedicatedIdentity ? carrier.guestHome : undefined;
  const nativeProcess = carrier.kind === 'native' && !dedicatedIdentity
    && (nativeGuestHome !== undefined || row.enrollmentIdentity?.kind === 'guestProcess');
  const configuration = {
    relay: { relayUrl: input.target.canonicalAuthUrl, webappUrl: input.target.webappUrl },
    homeTarget: input.target, managedEnrollment: correlation,
    machineDisplayName: row.launch.name,
    enrollmentIdentity: row.enrollmentIdentity,
    requireLocalApproval: true,
    channel: input.channel,
    serviceMode: nativeProcess ? 'none' as const : 'user' as const,
  };
  const runPreparedTask = deps.runTask;
  if (carrier.kind === 'ssh') {
    if (!sameStrictJsonValue(carrier.credentialRef, row.bootstrapCredentialRef) || !deps.runSshTask) {
      throw new SystemTaskExecutionError('credential_unavailable', 'The retained bootstrap credential is unavailable.');
    }
    const host = carrier.port && carrier.port !== 22 ? `[${carrier.address}]:${carrier.port}` : carrier.address;
    // Generating a credential does not prove the provider installed its host
    // identity. Native images (including Lume) retain their own SSH host keys.
    const trustedHostKey = carrier.hostKeySource === 'retained-credential' && input.guestHostPublicKey !== undefined
      ? parseSshKnownHostLine(`${host} ${input.guestHostPublicKey}`)?.line : undefined;
    if (carrier.hostKeySource === 'retained-credential' && trustedHostKey === undefined) {
      throw new SystemTaskExecutionError('credential_unavailable', 'The installed guest host identity is unavailable.');
    }
    return await deps.runSshTask({ configuration, reviewedChild: input.reviewedChild, carrier, assertCurrent, deliverAuthApproval, onEnrollmentDeadline,
      ...(trustedHostKey === undefined ? {} : { trustedHostKey }),
      prepareDedicatedBootstrap: async ({ exec, binaryPath, context, channel }) => {
        await prepareDedicatedDaemonBootstrap({ row, correlation, binaryPath, channel, exec,
          emit: context.emit, prompt: context.prompt, signal: input.signal, createPromptId: deps.createPromptId });
      },
    });
  }
  if (!sameStrictJsonValue(carrier.transport.contributionRef, correlation.resource.contributionRef)
    || carrier.transport.schemaVersion !== correlation.resource.schemaVersion || !deps.native) {
    throw new SystemTaskExecutionError('resource_mismatch', 'Native bootstrap transport does not address the retained resource.');
  }
  const native = deps.native;
  const wrapNativeCommand = (command: string) => buildManagedNativeGuestCommand(command, nativeGuestHome);
  const exec: ManagedNativeBootstrapIO['exec'] = async (request) => {
    input.signal?.throwIfAborted();
    request.signal?.throwIfAborted();
    const command = wrapNativeCommand(request.command);
    return await native.exec({ ...request, command, signal: request.signal ?? input.signal });
  };
  const putFile: ManagedNativeBootstrapIO['putFile'] = async (request) => {
    input.signal?.throwIfAborted();
    request.signal?.throwIfAborted();
    return await native.putFile({ ...request, signal: request.signal ?? input.signal });
  };
  const payloadExec: ManagedNativeBootstrapIO['exec'] = request => exec({ ...request,
    command: dedicatedIdentity ? buildDedicatedDaemonInvocationCommand(request.command) : request.command });
  const configureNativeBoot = async (installedBinaryPath: string, options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>) => {
    if (!nativeGuestHome) return;
    await startManagedNativeGuestDaemon({ native, binaryPath: installedBinaryPath, channel: configuration.channel,
      guestHome: nativeGuestHome, signal: options?.signal ?? input.signal, timeoutMs: options?.timeoutMs });
  };
  // Registration may commit before the native config update is confirmed.
  // Retry the retained installation's boot config, not installation/pairing.
  if (row.enrolledMachineId && nativeGuestHome) {
    await configureNativeBoot(resolveRemoteInstalledFirstPartyBinaryPath({
      componentId: 'happier-cli', channel: configuration.channel, remoteHomeDir: nativeGuestHome.happyHomeDir,
    }));
    return { machineId: row.enrolledMachineId };
  }
  const observation = correlation.resource.devcontainerObservation;
  if (observation) {
    const namespace = await exec({ command: 'id -un; pwd -P' });
    // The first LF frames the username; only the final LF frames the path.
    // Paths themselves may contain newlines and must not be trimmed or split.
    const boundary = namespace.stdout.indexOf('\n');
    const user = boundary < 0 ? '' : namespace.stdout.slice(0, boundary);
    const workspaceFolder = boundary < 0 || !namespace.stdout.endsWith('\n')
      ? '' : namespace.stdout.slice(boundary + 1, -1);
    if (namespace.status !== 0 || user !== observation.user || workspaceFolder !== observation.workspaceFolder) {
      throw new SystemTaskExecutionError('resource_mismatch', 'Native guest namespace differs from the admitted observation.');
    }
    input.signal?.throwIfAborted();
  }
  let binaryPath = '';
  const installRemoteCli = async (signal?: AbortSignal, context?: Pick<InteractiveSystemTaskContext, 'taskId' | 'emit' | 'prompt'>) => {
    await installSharedRemoteCli({ channel: configuration.channel, signal,
      bootstrap: { parsed: configuration, context, enrolledMachineId: row.enrolledMachineId, createPromptId: deps.createPromptId,
        prepareManagedBootstrap: async ({ exec, binaryPath, context, channel }) => {
          await prepareDedicatedDaemonBootstrap({ row, correlation, binaryPath, channel, exec,
            emit: context.emit, prompt: context.prompt, signal, createPromptId: deps.createPromptId });
        },
      },
      transport: { exec, install: async placement => {
        const platform = await exec({ command: 'uname -s; uname -m; printf "%s\\n" "$HOME"', signal });
        if (platform.status !== 0) throw new SystemTaskExecutionError('provider_unavailable', 'Native guest platform could not be observed.');
        const [os, arch, home] = platform.stdout.trim().split(/\r?\n/u);
        if (!home?.startsWith('/')) throw new SystemTaskExecutionError('provider_unavailable', 'Native guest home could not be observed.');
        const installation = { channel: configuration.channel, signal, os: normalizeRemoteReleaseOs(os), arch: normalizeRemoteReleaseArch(arch), home,
          remoteHomeDir: placement.remoteHomeDir ?? nativeGuestHome?.happyHomeDir, dedicatedIdentity: !!dedicatedIdentity,
          resource: correlation.resource.value, exec: payloadExec, putFile, bootstrapExec: exec,
          cleanupExec: (request: Parameters<ManagedNativeBootstrapIO['exec']>[0]) => native.exec(request) };
        const installed = deps.installNativePayload ? await deps.installNativePayload(installation) : await installNativeSelfDownload(installation);
        binaryPath = installed.binaryPath;
        return installed;
      } },
    });
    await input.onInstalled?.();
  };
  const executor = createHappierJsonExecutorFromTextRunner(async (args, options) => {
      if (!binaryPath) throw new SystemTaskExecutionError('cli_capability_missing', 'The native guest binary has not been installed.');
      return await payloadExec({ command: buildRemoteHappierInvocationCommand({ binaryPath, args, channel: configuration.channel }), ...options,
        timeoutMs: options?.timeoutMs === undefined ? resolveLocalHappierCommandTimeoutMs(args) : options.timeoutMs,
      });
  });
  if (row.enrolledMachineId) {
    // Service-managed guests can update the installed CLI without issuing a new
    // sign-in or changing the existing Machine. Native-process boot recovery is
    // handled above and continues to reuse its retained installation.
    await installRemoteCli(input.signal);
    const commands = nativeProcess ? [['daemon', 'start', '--json']]
      : ['install', 'restart'].map(action => ['daemon', 'service', action, ...(dedicatedIdentity ? ['--mode=user'] : []), '--json']);
    // An unchanged service definition can keep running the old payload at the
    // same CLI version. Adopt the promoted payload through its lifecycle owner.
    for (const args of commands) {
      const updated = await payloadExec({
        command: buildRemoteHappierInvocationCommand({ binaryPath, args, channel: configuration.channel }),
        signal: input.signal,
        timeoutMs: resolveLocalHappierCommandTimeoutMs(args),
      });
      if (updated.status !== 0) throw new SystemTaskExecutionError('background_service_failed', 'The updated guest background service could not be activated.');
      input.signal?.throwIfAborted();
    }
    // Installation can replace the guest daemon before Home acknowledges its
    // new control socket. Reuse enrollment's native readiness owner before the
    // retained controller dispatches policy children; never retry installation.
    const ready = await createEnrollMachineFlowExecutorFromHappierJsonExecutor({ executor }).waitForReadyDaemon!({
      signal: input.signal, requireMachineControlReady: true,
      // Retained retries have no fresh pairing deadline. Their admitted operation
      // already owns cancellation (including its deadline); standalone calls keep
      // the readiness owner's default instead of inventing a second lifetime.
      timeoutMs: input.operationId && input.signal ? null : undefined,
      requireServiceInstalled: !nativeProcess,
    });
    // Like the enrollment flow, reject the waiter's final deadline observation
    // when the service itself is not ready, even if control was acknowledged.
    if ((!nativeProcess && !ready.serviceInstalled) || !ready.daemonRunning || ready.needsAuth) throw new SystemTaskExecutionError(
      'daemon_service_not_ready', 'The updated guest background service did not reach a ready state.');
    if (ready.machineId !== row.enrolledMachineId) throw new SystemTaskExecutionError('machine_registration_unconfirmed',
      'The replacement daemon did not confirm the retained Machine.');
    input.signal?.throwIfAborted();
    return { machineId: row.enrolledMachineId };
  }
  const task = createRemoteNativeBootstrapMachineTaskKind({
    onEnrollmentDeadline,
    reviewedChild: input.reviewedChild,
    deliverAuthApproval,
    configuration, executor, assertCurrent: async () => { await assertCurrent(); },
    installRemoteCli,
    ...(nativeGuestHome ? { startDaemonProcess: (options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>) => configureNativeBoot(binaryPath, options) } : {}),
    approveLocalAuthRequest: deps.approveLocalAuthRequest,
  });
  const enrolled = await runPreparedTask(task);
  return enrolled;
}
