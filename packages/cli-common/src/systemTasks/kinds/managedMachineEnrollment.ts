import type { ResolvedHomeTarget } from '../../homeTarget/homeTarget.js';
import type { GuestCliIdentityV1 } from '@happier-dev/protocol/features';
import type { ManagedEnrollmentCorrelationV1, ManagedEnrollmentFullCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { DeploymentAppEnrollmentCorrelationV1Schema, type DeploymentAppEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/enrollmentV1';
import type { DeploymentAppMachineBindingV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { readManagedMachineRequesterEnrollmentAccountIdV1 } from '@happier-dev/protocol/machines/managed/enrollmentIdentityV1';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';
import type { MachineProvisionerProcessConfigV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { InteractiveSystemTaskContext, InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import { createRemoteNativeBootstrapMachineTaskKind } from './remoteSshBootstrapMachineKind.js';
import type { PrepareManagedDedicatedBootstrap } from '../ssh/installRemoteCli.js';
import { installRemoteDaemonLifecycle } from './remoteDaemonLifecycle.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionIdentity';
import { resolveManagedMachineEnrollmentRolesV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ManagedEnrollmentFullCorrelationV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedBootstrapCarrierV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { ManagedMachineBootstrapPromptV1Schema, type ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import { parseSshTrustPromptData } from '@happier-dev/protocol/system/tasks/promptPayloadContracts';
import { buildRemoteHappierInvocationCommand, buildDedicatedDaemonInvocationCommand } from '../ssh/remoteBootstrapCommandBuilder.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '../ssh/remoteFirstPartyInstallPath.js';
import { installRemoteCli as installSharedRemoteCli } from '../ssh/installRemoteCli.js';
import { prepareDedicatedDaemonBootstrap } from '../ssh/dedicatedDaemonBootstrap.js';
import { createHappierJsonExecutorFromTextRunner } from '../executors/happierJsonExecutorFromTextRunner.js';
import { createEnrollMachineFlowExecutorFromHappierJsonExecutor } from '../executors/enrollMachineFlowExecutor.js';
import { readLocalServerProfileIdentity } from '../executors/serverProfileScope.js';
import { resolveLocalHappierCommandTimeoutMs } from '../executors/happierJsonExecutorFromTextRunner.js';
import type { InteractiveSystemTaskPromptRequest } from '../interactiveTaskKinds.js';
import { readManagedSshTrustedHostKey } from './sshHostTrustResolution.js';
import { buildManagedNativeGuestCommand, buildManagedNativeGuestDaemonCommand, probeManagedNativeGuestPlatform, resolveManagedNativeGuestStartup, startManagedNativeGuestDaemon } from '../../machines/managed/nativeBootstrap.js';
import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import { DEFAULT_COMMAND_CAPTURE_MAX_BYTES } from '../../process/commandCaptureBudget.js';
import { GuestServiceFailureFactsV1Schema, readGuestCliFailureOutput } from '@happier-dev/protocol/ssh/commandFailure';

export type ManagedNativeBootstrapIO = Readonly<{
  exec(input: Readonly<{ command: string; input?: string; signal?: AbortSignal; timeoutMs?: number | null; allowWake?: false;
    onStdoutChunk?: (text: string) => void; processConfig?: MachineProvisionerProcessConfigV1 }>): Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
  putFile(input: Readonly<{ path: string; bytes: Uint8Array; signal?: AbortSignal }>): Promise<void>;
}>;

type NativeTaskOptions = Parameters<typeof createRemoteNativeBootstrapMachineTaskKind>[0];
export type ManagedNativePayloadInstallation = Readonly<{
  guestCli?: GuestCliIdentityV1;
  channel: 'stable' | 'preview' | 'dev';
  homeUrl: string;
  os: 'linux' | 'darwin'; arch: 'x64' | 'arm64'; home: string;
  remoteHomeDir?: string; dedicatedIdentity: boolean;
  resource: ManagedEnrollmentFullCorrelationV1['resource']['value'];
  signal?: AbortSignal;
  exec: ManagedNativeBootstrapIO['exec']; putFile: ManagedNativeBootstrapIO['putFile'];
  bootstrapExec: ManagedNativeBootstrapIO['exec']; cleanupExec: ManagedNativeBootstrapIO['exec'];
  onPhase?(phase: 'prepare' | 'archive' | 'transfer' | 'promote'): void;
  onTransferProgress?(progress: Readonly<{ transferredBytes: number; totalBytes: number }>): void;
}>;

export type ManagedMachineEnrollmentInput = Readonly<{
  correlation: ManagedEnrollmentFullCorrelationV1;
  homeCorrelation: ManagedEnrollmentCorrelationV1;
  target: ResolvedHomeTarget;
  carrier: unknown;
  /** Only the retained generated bundle supplies this; scanner evidence is not trust. */
  guestHostPublicKey?: string;
  operationId?: string;
  /** Explicit Retry install replaces the payload; ordinary boot recovery reuses it. */
  replacePayload?: boolean;
  /** Home-issued snapshot from this Retry root's admission; Create uses its retained row. */
  guestCli?: GuestCliIdentityV1;
  /** Persist successful installation before ordinary Account pairing starts. */
  onInstalled?(): Promise<void>;
  /** Host-private admitted Create carrier; never part of task params or a wire input. */
  reviewedChild?: HostReviewedChildPortV1;
  signal?: AbortSignal;
  channel: 'stable' | 'preview' | 'dev';
}>;

/** Compose owns this daemon's image, foreground process and retained Home. */
export type DeploymentAppMachineEnrollmentInput = Readonly<{
  source: 'deploymentApp';
  enrollment: DeploymentAppEnrollmentCorrelationV1;
  target: ResolvedHomeTarget;
  machineDisplayName: string;
  binaryPath: string;
  homeDir: string;
  happyHomeDir: string;
  deploymentAppBinding: DeploymentAppMachineBindingV1;
  enrollmentAccountId: string;
  guestCli?: GuestCliIdentityV1;
  /** The existing Compose owner replaces PID 1 after first payload installation. */
  restartDaemon(): Promise<void>;
  /** Bind the existing terminal request to this admitted App before Account approval. */
  onPairingRequest(publicKey: string): Promise<void>;
  /** A retained Home reuses its registered child instead of pairing again. */
  onExistingMachine(machineId: string): Promise<void>;
  operationId?: string;
  signal?: AbortSignal;
  channel: ManagedMachineEnrollmentInput['channel'];
}>;

export type ManagedMachineEnrollmentDependencies = Readonly<{
  readCurrentManagedRow(): Promise<ManagedMachineFullV1>;
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

export type DeploymentAppMachineEnrollmentDependencies = Pick<ManagedMachineEnrollmentDependencies,
  'native' | 'runTask' | 'approveLocalAuthRequest' | 'onEnrollmentDeadline' | 'installNativePayload'>;

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
export async function runManagedMachineEnrollment(input: ManagedMachineEnrollmentInput | DeploymentAppMachineEnrollmentInput,
  deps: ManagedMachineEnrollmentDependencies | DeploymentAppMachineEnrollmentDependencies): Promise<Readonly<{ machineId: string }>> {
  if ('source' in input) return runDeploymentAppEnrollment(input, deps);
  if (!('readCurrentManagedRow' in deps)) throw new SystemTaskExecutionError('admission_unavailable', 'Managed enrollment requires its admitted resource owner.');
  const correlation = ManagedEnrollmentFullCorrelationV1Schema.parse(input.correlation);
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
  const enrollmentAccountId = readManagedMachineRequesterEnrollmentAccountIdV1(row);
  const requesterEnrollment = enrollmentAccountId !== undefined;
  const deliverAuthApproval = requesterEnrollment
    ? deps.createPairingDelivery?.(enrollmentAccountId) ?? deps.deliverAuthApproval
    : deps.deliverAuthApproval;
  if (requesterEnrollment && !row.enrolledMachineId && !deliverAuthApproval) {
    throw new SystemTaskExecutionError('admission_unavailable', 'Requester enrollment requires its owning Account pairing delivery.');
  }
  const dedicatedIdentity = row.enrollmentIdentity?.kind === 'dedicatedDaemonUser' ? row.enrollmentIdentity : undefined;
  const guestCli = input.replacePayload ? input.guestCli : row.guestCli;
  if (input.replacePayload && row.guestCli?.payloads && !guestCli) {
    throw new SystemTaskExecutionError('guest_payload_missing', 'Update requires the Home payload captured by its admission.');
  }
  let nativeProcess = carrier.kind === 'native' && !dedicatedIdentity
    && (carrier.guestHome !== undefined || carrier.daemonStartup === 'native-process' || row.enrollmentIdentity?.kind === 'guestProcess');
  const roles = resolveManagedMachineEnrollmentRolesV1(row.enrollmentIdentity, row.resource?.origin);
  const initialMachineMetadata = {
    ...(roles ? { rolesV1: roles } : {}),
    ...(row.resource?.origin === 'created' ? { isolationV1: {
      environment: 'managed-guest' as const, provisionerId: buildQualifiedPluginContributionKey(row.resource.contributionRef),
    } } : {}),
  };
  const configuration = {
    relay: { relayUrl: input.target.canonicalAuthUrl, webappUrl: input.target.webappUrl },
    homeTarget: input.target, managedEnrollment: input.homeCorrelation,
    machineDisplayName: row.launch.name, initialMachineMetadata,
    enrollmentIdentity: row.enrollmentIdentity,
    requireLocalApproval: true,
    channel: input.channel,
    ...(guestCli ? { guestCli } : {}),
    serviceMode: nativeProcess ? 'none' as const : 'user' as const,
  };
  const runPreparedTask = deps.runTask;
  if (carrier.kind === 'ssh') {
    if (!sameStrictJsonValue(carrier.credentialRef, row.bootstrapCredentialRef) || !deps.runSshTask) {
      throw new SystemTaskExecutionError('credential_unavailable', 'The retained bootstrap credential is unavailable.');
    }
    // Generating a credential does not prove the provider installed its host
    // identity. Native images (including Lume) retain their own SSH host keys.
    const trustedHostKey = readManagedSshTrustedHostKey(carrier, input.guestHostPublicKey);
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
  const { home: nativeGuestHome, platform: nativePlatform } = dedicatedIdentity ? {}
    : await resolveManagedNativeGuestStartup(carrier, request => native.exec(request), input.signal);
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
  if (row.enrolledMachineId && nativeGuestHome && !input.replacePayload) {
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
      bootstrap: { parsed: configuration, context, enrolledMachineId: row.enrolledMachineId,
        bootstrapInstalled: row.bootstrapInstalled, createPromptId: deps.createPromptId,
        prepareManagedBootstrap: async ({ exec, binaryPath, context, channel }) => {
          await prepareDedicatedDaemonBootstrap({ row, correlation, binaryPath, channel, exec,
            emit: context.emit, prompt: context.prompt, signal, createPromptId: deps.createPromptId });
        },
      },
      transport: { exec, install: async placement => {
        const { os, arch, home } = nativePlatform ?? await probeManagedNativeGuestPlatform(exec, signal);
        const installation = { channel: configuration.channel, homeUrl: input.target.applicationUrl, signal, os, arch, home,
          ...(guestCli ? { guestCli } : {}),
          remoteHomeDir: placement.remoteHomeDir ?? nativeGuestHome?.happyHomeDir, dedicatedIdentity: !!dedicatedIdentity,
          resource: correlation.resource.value, exec: payloadExec, putFile, bootstrapExec: exec,
          cleanupExec: (request: Parameters<ManagedNativeBootstrapIO['exec']>[0]) => native.exec(request),
          onPhase: (phase: 'prepare' | 'archive' | 'transfer' | 'promote') => {
            // Progress words a person reads on the machine's page: what happens, not how it is shipped.
            const message = { prepare: 'Preparing Happier for this machine', archive: 'Packing Happier for this machine',
              transfer: 'Copying Happier to this machine', promote: 'Installing Happier' }[phase];
            context?.emit({ type: 'progress', stepId: `ssh.installCli.${phase}`, message });
          },
          onTransferProgress: ({ transferredBytes, totalBytes }: Readonly<{ transferredBytes: number; totalBytes: number }>) => {
            context?.emit({ type: 'progress', stepId: 'ssh.installCli.transfer',
              message: `Copying Happier to this machine: ${Math.floor(transferredBytes / 1048576)} of ${Math.max(1, Math.ceil(totalBytes / 1048576))} MB` });
          } };
        if (!deps.installNativePayload) throw new SystemTaskExecutionError('guest_payload_missing', 'This app cannot read the Home guest CLI payload. Choose a connected controller to install this machine, then retry.');
        const installed = await deps.installNativePayload(installation);
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
    // Enrolled guests can update the installed CLI without issuing a new
    // sign-in or changing the existing Machine. Native-process boot recovery is
    // handled above and continues to reuse its retained installation.
    await installRemoteCli(input.signal);
    const runCommand = async (step: 'install' | 'restart', process: boolean) => {
      const args = process ? ['daemon', 'restart', '--json']
        : ['daemon', 'service', step, ...(dedicatedIdentity ? ['--mode=user'] : []), '--json'];
      const invocation = { binaryPath, args, channel: configuration.channel };
      const updated = await payloadExec({
        command: process && nativeGuestHome ? buildManagedNativeGuestDaemonCommand(invocation) : buildRemoteHappierInvocationCommand(invocation),
        signal: input.signal,
        timeoutMs: resolveLocalHappierCommandTimeoutMs(args),
      });
      const cause = process ? null : GuestServiceFailureFactsV1Schema.safeParse(readGuestCliFailureOutput(updated.stdout, updated.stderr));
      if (updated.status !== 0 || cause?.success) throw new SystemTaskExecutionError('background_service_failed', 'The updated guest background service could not be activated.', {
        details: process
          ? { kind: 'managedService', step, exitStatus: updated.status,
            stderrTail: trimBugReportTextToMaxBytes(redactBugReportSensitiveText(updated.stderr), DEFAULT_COMMAND_CAPTURE_MAX_BYTES) }
          : { kind: 'managedService', step, exitStatus: updated.status, cause: cause?.success ? cause.data : null },
      });
      input.signal?.throwIfAborted();
    };
    nativeProcess = await installRemoteDaemonLifecycle({ preferProcess: nativeProcess,
      installService: () => runCommand('install', false) }) === 'process';
    // Adoption restarts the selected lifecycle even when the CLI version matches.
    await runCommand('restart', nativeProcess);
    if (nativeGuestHome) await configureNativeBoot(binaryPath);
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
  try {
    return await runPreparedTask(task);
  } catch (error) {
    // Enrollment's typed transport result owns reachability. The provisioner
    // contributes only authored-network context, never another probe/refusal.
    if (carrier.homeNetworkHint && error instanceof SystemTaskExecutionError
      && error.code === 'home_not_guest_reachable' && error.details?.kind === 'managedGuestHome') {
      throw new SystemTaskExecutionError(error.code,
        `${error.message} This configuration keeps its authored networking. Configure host networking in the devcontainer or Compose source, or provide a Home endpoint reachable from that network.`,
        { cause: error, details: { ...error.details, reason: carrier.homeNetworkHint } });
    }
    throw error;
  }
}

/** A new admitted source uses the same task, approval and registration recipe. */
async function runDeploymentAppEnrollment(input: DeploymentAppMachineEnrollmentInput,
  deps: DeploymentAppMachineEnrollmentDependencies): Promise<Readonly<{ machineId: string }>> {
  const enrollment = DeploymentAppEnrollmentCorrelationV1Schema.parse(input.enrollment);
  if (input.target.homeServerIdentityId !== enrollment.homeId || !input.target.descriptor) {
    throw new SystemTaskExecutionError('home_identity_mismatch', 'App enrollment requires its admitted Home descriptor.');
  }
  if (!deps.native) throw new SystemTaskExecutionError('resource_mismatch', 'App enrollment requires its admitted native service.');
  const native = deps.native;
  let binaryPath = input.binaryPath;
  const exec: ManagedNativeBootstrapIO['exec'] = request => native.exec({ ...request,
    command: buildManagedNativeGuestCommand(request.command, { homeDir: input.homeDir, happyHomeDir: input.happyHomeDir }),
    signal: request.signal ?? input.signal });
  const executor = createHappierJsonExecutorFromTextRunner(async (args, options) => {
    input.signal?.throwIfAborted();
    return exec({ ...options, command: buildRemoteHappierInvocationCommand({
      binaryPath, args, channel: input.channel,
    }), signal: options?.signal ?? input.signal,
      timeoutMs: options?.timeoutMs === undefined ? resolveLocalHappierCommandTimeoutMs(args) : options.timeoutMs });
  });
  const result = await deps.runTask(createRemoteNativeBootstrapMachineTaskKind({
    configuration: { relay: { relayUrl: input.target.canonicalAuthUrl, webappUrl: input.target.webappUrl },
      homeTarget: input.target, managedEnrollment: enrollment, deploymentAppBinding: input.deploymentAppBinding,
      machineDisplayName: input.machineDisplayName,
      serviceMode: 'none', channel: input.channel },
    executor,
    readInitialAuthStatus: async () => {
      const status = await createEnrollMachineFlowExecutorFromHappierJsonExecutor({ executor }).readAuthStatus();
      if (status.credentialState !== 'missing') {
        const scope = await readLocalServerProfileIdentity(executor, { serverUrl: input.target.canonicalAuthUrl,
          serverIdentityId: enrollment.homeId, requireRecordedHomeIdentity: true });
        if (!scope.serverId || scope.serverId !== scope.activeServerId) throw new SystemTaskExecutionError('home_identity_mismatch',
          'The retained App Home does not match the admitted Home.');
        if (status.accountId !== input.enrollmentAccountId) throw new SystemTaskExecutionError('machine_registration_unconfirmed',
          'The retained App Home belongs to a different Account.');
        if (status.credentialState === 'valid' && status.machineRegistrationState === 'server-confirmed' && status.machineId) {
          await input.onExistingMachine(status.machineId);
        }
      }
      return status;
    },
    installRemoteCli: async signal => {
      if (!deps.installNativePayload) throw new SystemTaskExecutionError('guest_payload_missing', 'App enrollment requires the existing Home CLI payload owner.');
      const platform = await probeManagedNativeGuestPlatform(exec, signal);
      const installed = await deps.installNativePayload({ ...platform, channel: input.channel,
        homeUrl: input.target.applicationUrl, remoteHomeDir: input.happyHomeDir, dedicatedIdentity: false,
        ...(input.guestCli ? { guestCli: input.guestCli } : {}),
        resource: enrollment, signal, exec, putFile: native.putFile, bootstrapExec: exec, cleanupExec: native.exec });
      binaryPath = installed.binaryPath;
    },
    startDaemonProcess: async () => { await input.restartDaemon(); },
    assertCurrent: async () => { input.signal?.throwIfAborted(); },
    onEnrollmentDeadline: deadline => deps.onEnrollmentDeadline?.(deadline, 'native'),
    approveLocalAuthRequest: deps.approveLocalAuthRequest,
    approveAdmittedEnrollmentRequest: async request => {
      await input.onPairingRequest(request.publicKey);
      await deps.approveLocalAuthRequest(request);
    },
  }));
  return result;
}
