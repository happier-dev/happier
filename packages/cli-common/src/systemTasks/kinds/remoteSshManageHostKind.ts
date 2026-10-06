import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import type { HomeConnectionDescriptorV1, SystemTaskJsonObject, SystemTaskJsonValue } from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { normalizePublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { SystemTaskExecutionError } from '../runSystemTask.js';
import { redactSensitiveSystemTaskJsonValue, type InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import { parseSystemTaskSshConfig, type SystemTaskSshConnectionConfig } from './relayRuntimeKinds.js';
import type { RemoteHostTrustResolution } from './remoteSshBootstrapMachineKind.js';
import { preflightRemoteBackgroundServiceReplacement } from './remoteSshBootstrapMachineKind.js';
import { materializeSshIdentityPrivateKeyToTempFile } from '../ssh/materializeSshIdentityPrivateKeyToTempFile.js';
import {
  PersonalHomeRelocationTransferCleanupError,
  type PersonalHomeRelocationPublicationFacts,
} from '../../firstPartyRuntime/personalHome/relocationCoordinator.js';
import {
  parsePersonalHomeRelocationDestinationFacts,
  type PersonalHomeRelocationDestinationFacts,
  type PersonalHomeRelocationDestinationOwner,
  type PersonalHomeRelocationDestinationStageInput,
} from '../../firstPartyRuntime/personalHome/relocationDestination.js';

/**
 * The one remedy for `release_channel_switch_declined`. Like the service
 * refusal, it names no CLI flag or app control so it stays true on every host.
 */
export function releaseChannelSwitchDeclinedMessage(
  params: Readonly<{
    currentDefaultReleaseChannel: 'stable' | 'preview' | 'dev';
    targetReleaseChannel: 'stable' | 'preview' | 'dev';
  }>,
): string {
  return `The remote default release channel stayed ${params.currentDefaultReleaseChannel}, so the ${params.targetReleaseChannel} Home was not created. Start again and choose to switch the channel.`;
}

export type RemoteSshManageHostAction =
  | 'testConnection'
  | 'installOrUpdateCli'
  | 'daemonService.installOrUpdate'
  | 'daemonService.start'
  | 'daemonService.stop'
  | 'daemonService.restart'
  | 'relayRuntime.status'
  | 'relayRuntime.installOrUpdate'
  | 'relayRuntime.start'
  | 'relayRuntime.stop'
  | 'relayRuntime.restart'
  | 'personalHome.create'
  | 'personalHome.status'
  | 'personalHome.backup'
  | 'personalHome.verifyBackup'
  | 'personalHome.restore'
  | 'personalHome.recoverRestore'
  | 'personalHome.relocate'
  | 'personalHome.erase';

export type RemoteSshAuth =
  | Readonly<{ mode: 'agent' }>
  | Readonly<{ mode: 'keyFile'; privateKeyPath: string }>
  | Readonly<{ mode: 'password'; password: string }>;

export type RemoteSshManageHostDeps = Readonly<{
  resolveHostTrust: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    signal?: AbortSignal;
  }>) => Promise<RemoteHostTrustResolution>;
  testConnection: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    signal?: AbortSignal;
  }>) => Promise<void>;
  installRemoteCli: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    channel: 'stable' | 'preview' | 'dev';
    signal?: AbortSignal;
  }>) => Promise<void>;
  runDaemonServiceCommand: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    action: 'installOrUpdate' | 'start' | 'stop' | 'restart';
    serviceMode: 'user' | 'none';
    channel: 'stable' | 'preview' | 'dev';
    signal?: AbortSignal;
  }>) => Promise<void>;
  runRelayRuntimeCommand: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    action: 'status' | 'installOrUpdate' | 'start' | 'stop' | 'restart';
    channel: 'stable' | 'preview' | 'dev';
    mode: 'user' | 'system';
    signal?: AbortSignal;
  }>) => Promise<SystemTaskJsonObject | null | void>;
  runPersonalHomeCommand?: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    channel: 'stable' | 'preview' | 'dev';
    mode: 'user' | 'system';
    args: readonly string[];
    input?: string;
    resultContract?: 'create' | 'task';
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }>) => Promise<SystemTaskJsonObject>;
  transferPersonalHomeArchive?: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    direction: 'upload' | 'download';
    localPath: string;
    remotePath: string;
    signal?: AbortSignal;
  }>) => Promise<void>;
  createOperationId?: () => string;
  runPersonalHomePairDevice?: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    channel: 'stable' | 'preview' | 'dev';
    mode: 'user' | 'system';
    homeServerIdentityId: string;
    args: readonly string[];
    signal?: AbortSignal;
  }>) => Promise<Readonly<
    | { kind: 'completed'; requestedDeviceLabel: string | null }
    | { kind: 'cancelled' | 'expired' | 'invalid_request' | 'update_required' }
    | { kind: 'failed'; status: number }
  >>;
  enrollInvokingClient?: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    channel: 'stable' | 'preview' | 'dev';
    descriptor: HomeConnectionDescriptorV1;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ kind: 'enrolled' | 'failed' }>>;
  runPersonalHomeRelocation?: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    channel: 'stable' | 'preview' | 'dev';
    mode: 'user' | 'system';
    destinationMachineId: string;
    operationId: string;
    sourceDescriptorRevision: number;
    recoveryAction?: 'finish_move' | 'return_to_source';
    signal?: AbortSignal;
    progress(stepId: string, message?: string): void;
    publishDestination(facts: PersonalHomeRelocationPublicationFacts): Promise<HomeConnectionDescriptorV1>;
    readPublishedDescriptor(homeServerIdentityId: string): Promise<HomeConnectionDescriptorV1 | null>;
  }>) => Promise<SystemTaskJsonObject>;
}>;

const PERSONAL_HOME_RELOCATION_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PERSONAL_HOME_RELOCATION_SHA256 = /^[a-f0-9]{64}$/u;

function assertRelocationOperationId(operationId: string): void {
  if (!PERSONAL_HOME_RELOCATION_OPERATION_ID.test(operationId)) {
    throw new Error('Invalid Personal Home relocation operation id.');
  }
}

function parseRelocationUpload(value: SystemTaskJsonObject, operationId: string): Readonly<{
  uploadLocator: string;
}> {
  if (Object.keys(value).some((key) => !['operationId', 'uploadLocator'].includes(key))
    || value.operationId !== operationId
    || typeof value.uploadLocator !== 'string'
    || !value.uploadLocator.trim()
    || /[\r\n\0]/u.test(value.uploadLocator)) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home relocation destination returned an invalid upload reservation.');
  }
  return { uploadLocator: value.uploadLocator };
}

function sanitizeRelocationTransferError(error: unknown, uploadLocator: string): Error {
  const rawMessage = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Personal Home relocation archive transfer failed.';
  const sanitizedMessage = rawMessage.split(uploadLocator).join('[redacted-destination-upload]');
  return new Error(sanitizedMessage || 'Personal Home relocation archive transfer failed.');
}

/** One SSH destination protocol adapter shared by CLI and bootstrap hosts. */
export function createRemoteSshPersonalHomeRelocationDestination(params: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: RemoteSshAuth;
  knownHostsMode: 'app' | 'system';
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  runPersonalHomeCommand: NonNullable<RemoteSshManageHostDeps['runPersonalHomeCommand']>;
  transferPersonalHomeArchive: NonNullable<RemoteSshManageHostDeps['transferPersonalHomeArchive']>;
  ensureRuntime(purpose: Readonly<{ kind: 'personal-home'; canonicalServerUrl: string }>, signal?: AbortSignal): Promise<void>;
}>): PersonalHomeRelocationDestinationOwner {
  const destinationCommand = async (args: readonly string[], signal?: AbortSignal) => await params.runPersonalHomeCommand({
    ssh: params.ssh,
    auth: params.auth,
    knownHostsMode: params.knownHostsMode,
    channel: params.channel,
    mode: params.mode,
    args: ['home', 'relocation-destination', ...args, '--json', '--channel', params.channel, '--mode', params.mode],
    ...(signal ? { signal } : {}),
  });
  const remoteCommand = async (args: readonly string[], operationId: string, signal?: AbortSignal) => parsePersonalHomeRelocationDestinationFacts(
    await destinationCommand(args, signal),
    operationId,
  );
  const status = async (operationId: string) => {
    assertRelocationOperationId(operationId);
    return await remoteCommand(['status', '--operation-id', operationId], operationId);
  };

  return Object.freeze({
    status,
    stage: async (input: PersonalHomeRelocationDestinationStageInput) => {
      assertRelocationOperationId(input.operationId);
      if (!input.archivePath.trim()
        || !PERSONAL_HOME_RELOCATION_SHA256.test(input.bundleSha256)
        || !input.expectedHomeServerIdentityId.trim()
        || !input.expectedCanonicalServerUrl.trim()
        || !Number.isSafeInteger(input.sourceDescriptorRevision)
        || input.sourceDescriptorRevision < 1) {
        throw new Error('Invalid Personal Home relocation destination stage input.');
      }
      input.signal?.throwIfAborted();
      await params.ensureRuntime({ kind: 'personal-home', canonicalServerUrl: input.expectedCanonicalServerUrl }, input.signal);
      input.signal?.throwIfAborted();
      const upload = parseRelocationUpload(await destinationCommand([
        'stage', '--operation-id', input.operationId, '--prepare-upload',
      ], input.signal), input.operationId);
      let stagedFacts: PersonalHomeRelocationDestinationFacts | undefined;
      let stageFailure: unknown;
      try {
        try {
          await params.transferPersonalHomeArchive({
            ssh: params.ssh,
            auth: params.auth,
            knownHostsMode: params.knownHostsMode,
            direction: 'upload',
            localPath: input.archivePath,
            remotePath: upload.uploadLocator,
            ...(input.signal ? { signal: input.signal } : {}),
          });
        } catch (transferError) {
          const sanitizedTransferError = sanitizeRelocationTransferError(transferError, upload.uploadLocator);
          let cleanupConfirmed = false;
          try {
            const aborted = await remoteCommand(['abort', '--operation-id', input.operationId], input.operationId);
            cleanupConfirmed = (aborted.status === 'absent' || aborted.status === 'aborted')
              && aborted.transferCleanupNeedsAttention !== true;
          } catch {
            // Preserve the transfer failure and report only cleanup attention.
          }
          if (!cleanupConfirmed) throw new PersonalHomeRelocationTransferCleanupError(sanitizedTransferError);
          throw sanitizedTransferError;
        }
        try {
          const facts = await remoteCommand([
            'stage',
            '--operation-id', input.operationId,
            '--bundle-sha256', input.bundleSha256,
            '--expected-home-id', input.expectedHomeServerIdentityId,
            '--expected-canonical-server-url', input.expectedCanonicalServerUrl,
            '--source-descriptor-revision', String(input.sourceDescriptorRevision),
          ], input.operationId, input.signal);
          if (facts.status === 'absent'
            || facts.bundleSha256 !== input.bundleSha256
            || facts.expectedHomeServerIdentityId !== input.expectedHomeServerIdentityId
            || facts.sourceDescriptorRevision !== input.sourceDescriptorRevision) {
            throw new Error('Remote Personal Home relocation stage returned facts for a different bundle.');
          }
          stagedFacts = facts;
        } catch (stageError) {
          try {
            const current = await status(input.operationId);
            if (current.status !== 'absent'
              && current.bundleSha256 === input.bundleSha256
              && current.expectedHomeServerIdentityId === input.expectedHomeServerIdentityId
              && current.sourceDescriptorRevision === input.sourceDescriptorRevision
              && (current.status === 'quarantined' || current.status === 'active')) {
              stagedFacts = current;
            } else {
              stageFailure = stageError;
            }
          } catch {
            stageFailure = stageError;
          }
        }
      } catch (error) {
        stageFailure = error;
      }
      if (stageFailure) throw stageFailure;
      if (!stagedFacts) throw new Error('Remote Personal Home relocation stage did not return authoritative destination facts.');
      return stagedFacts;
    },
    commit: async (input) => {
      assertRelocationOperationId(input.operationId);
      const publishedDescriptor = HomeConnectionDescriptorV1Schema.parse(input.publishedDescriptor);
      return await remoteCommand([
        'commit', '--operation-id', input.operationId,
        '--published-descriptor-json', JSON.stringify(publishedDescriptor),
      ], input.operationId) as PersonalHomeRelocationDestinationFacts;
    },
    abort: async (operationId) => {
      assertRelocationOperationId(operationId);
      return await remoteCommand(['abort', '--operation-id', operationId], operationId);
    },
  });
}

export function redactRemoteSshManageHostPayload(value: SystemTaskJsonValue): SystemTaskJsonValue {
  return redactSensitiveSystemTaskJsonValue(value);
}

export type RemotePersonalHomeApprovalInput = Readonly<{
  v: 1;
  operation: 'restore' | 'recover-restore' | 'erase';
  canonicalServerUrl: string;
  homeServerIdentityId: string;
  paths: readonly string[];
  estimatedBytes: number | null;
  confirmed: true;
}>;

const REMOTE_HOME_APPROVAL_KEYS = new Set([
  'v',
  'operation',
  'canonicalServerUrl',
  'homeServerIdentityId',
  'paths',
  'estimatedBytes',
  'confirmed',
]);

export function parseRemotePersonalHomeApprovalInput(raw: string): RemotePersonalHomeApprovalInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home approval input is malformed.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home approval input is malformed.');
  }
  const record = value as Record<string, unknown>;
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    : [];
  if (Object.keys(record).some((key) => !REMOTE_HOME_APPROVAL_KEYS.has(key))
    || Object.keys(record).length !== REMOTE_HOME_APPROVAL_KEYS.size
    || record.v !== 1
    || (record.operation !== 'restore' && record.operation !== 'recover-restore' && record.operation !== 'erase')
    || typeof record.canonicalServerUrl !== 'string' || !record.canonicalServerUrl.trim()
    || typeof record.homeServerIdentityId !== 'string' || !record.homeServerIdentityId.trim()
    || !Array.isArray(record.paths) || paths.length !== record.paths.length || paths.length === 0
    || (record.estimatedBytes !== null && (typeof record.estimatedBytes !== 'number' || !Number.isSafeInteger(record.estimatedBytes) || record.estimatedBytes < 0))
    || record.confirmed !== true) {
    throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home approval input is malformed.');
  }
  return {
    v: 1,
    operation: record.operation,
    canonicalServerUrl: record.canonicalServerUrl.trim(),
    homeServerIdentityId: record.homeServerIdentityId.trim(),
    paths,
    estimatedBytes: record.estimatedBytes,
    confirmed: true,
  };
}

function serializeRemotePersonalHomeApprovalInput(value: RemotePersonalHomeApprovalInput): string {
  return `${JSON.stringify(value)}\n`;
}

export function createRemoteSshManageHostTaskKind(
  deps: RemoteSshManageHostDeps,
): InteractiveSystemTaskKind<SystemTaskJsonObject> {
  return {
    async run(ctx): Promise<SystemTaskJsonObject> {
      const parsed = parseRemoteSshManageHostParams(ctx.params);
      const knownHostsMode = parsed.knownHostsMode;
      let cleanupTempIdentityFile: (() => Promise<void>) | null = null;

      try {
        ctx.emit({
          type: 'progress',
          stepId: 'ssh.trust',
          message: 'Verifying SSH host trust',
        });

        const trustResolution = await deps.resolveHostTrust({
          ssh: parsed.ssh,
          knownHostsMode,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const trust = trustResolution.status === 'prompt'
          ? normalizeRemoteHostTrustResolution(trustResolution)
          : trustResolution;

        if (trust.status === 'prompt') {
          const answer = await ctx.prompt({
            kind: trust.promptKind,
            stepId: 'ssh.hostTrust',
            message: trust.promptMessage,
            data: trust.promptData,
          }) as { trusted?: boolean };
          if (answer?.trusted !== true) {
            await trust.decline?.();
            throw new SystemTaskExecutionError('host_trust_declined', 'SSH host trust was declined.');
          }
          await trust.accept();
        }

        const authResolution = await resolveRemoteSshAuth({
          ctx,
          ssh: parsed.ssh,
          identityPrivateKey: parsed.identityPrivateKey,
        });
        cleanupTempIdentityFile = authResolution.cleanup;
        const auth = authResolution.auth;

        if (parsed.action === 'testConnection') {
          ctx.emit({
            type: 'progress',
            stepId: 'ssh.testConnection',
            message: 'Testing SSH connection',
          });
          await deps.testConnection({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return { action: parsed.action } satisfies SystemTaskJsonObject;
        }

        if (parsed.action === 'installOrUpdateCli') {
          ctx.emit({
            type: 'progress',
            stepId: 'remote.cli.install',
            message: 'Installing Happier CLI',
          });
          await deps.installRemoteCli({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
            channel: parsed.channel,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return { action: parsed.action } satisfies SystemTaskJsonObject;
        }

        if (parsed.action === 'personalHome.relocate') {
          if (!deps.runPersonalHomeRelocation) throw new SystemTaskExecutionError('unsupported', 'Remote Personal Home relocation is unavailable.');
          if (!parsed.relayRuntime || !parsed.personalHomeRelocation) {
            throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home relocation requires an exact runtime target and operation.');
          }
          const relocation = parsed.personalHomeRelocation;
          const runtimeChannel = parsed.relayRuntime.channel ?? 'stable';
          const runtimeMode = parsed.relayRuntime.mode ?? 'user';
          ctx.emit({ type: 'progress', stepId: 'remote.cli.install', message: 'Ensuring Happier CLI is installed' });
          await deps.installRemoteCli({ ssh: parsed.ssh, auth, knownHostsMode, channel: parsed.channel, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          const personalHome = await deps.runPersonalHomeRelocation({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
            channel: runtimeChannel,
            mode: runtimeMode,
            destinationMachineId: relocation.destinationMachineId,
            operationId: relocation.operationId,
            sourceDescriptorRevision: relocation.sourceDescriptorRevision,
            ...(relocation.recoveryAction ? { recoveryAction: relocation.recoveryAction } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            progress: (stepId, message) => ctx.emit({
              type: 'progress',
              stepId: stepId.startsWith('personal_home.') ? stepId : `personal_home.${stepId}`,
              ...(message ? { message } : {}),
            }),
            publishDestination: async (facts) => parseRelocationDescriptorPromptAnswer(await ctx.prompt({
              kind: 'personal_home.publish_relocation_descriptor.v1',
              stepId: 'personal_home.publish_relocation_descriptor',
              message: 'Publishing the verified Personal Home destination',
              data: facts,
              nonCancellable: true,
            }), false),
            readPublishedDescriptor: async (homeServerIdentityId) => parseRelocationDescriptorPromptAnswer(await ctx.prompt({
              kind: 'personal_home.read_relocation_descriptor.v1',
              stepId: 'personal_home.read_relocation_descriptor',
              message: 'Reading the current Personal Home destination',
              data: { operationId: relocation.operationId, homeServerIdentityId },
              nonCancellable: true,
            }), true),
          });
          return { action: parsed.action, personalHome } satisfies SystemTaskJsonObject;
        }

        if (parsed.action === 'personalHome.create') {
          if (!deps.runPersonalHomeCommand) throw new SystemTaskExecutionError('unsupported', 'Remote Personal Home creation is unavailable.');
          if (!parsed.relayRuntime) {
            throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home creation requires an explicit runtime target.');
          }
          const runtimeChannel = parsed.relayRuntime.channel ?? 'stable';
          const runtimeMode = parsed.relayRuntime.mode ?? 'user';
          ctx.emit({ type: 'progress', stepId: 'remote.cli.install', message: 'Ensuring Happier CLI is installed' });
          await deps.installRemoteCli({ ssh: parsed.ssh, auth, knownHostsMode, channel: parsed.channel, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          const replaceServices = parsed.replaceServices || await preflightRemoteBackgroundServiceReplacement({
            ctx,
            listServices: async () => unwrapRemoteCliJsonData(await deps.runPersonalHomeCommand!({
              ssh: parsed.ssh,
              auth,
              knownHostsMode,
              channel: parsed.channel,
              mode: runtimeMode,
              args: ['service', 'list', '--json'],
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            })),
            targetReleaseChannel: runtimeChannel,
            targetServerUrl: null,
            mode: runtimeMode,
            stepId: 'personal_home.service_preflight',
          });
          let switchChannel = parsed.switchChannel;
          if (!switchChannel) {
            let currentDefaultReleaseChannel: 'stable' | 'preview' | 'dev' | null = null;
            let managedReleaseChannels: SystemTaskJsonValue[] = [];
            try {
              const releaseStatus = unwrapRemoteCliJsonData(await deps.runPersonalHomeCommand({
                ssh: parsed.ssh,
                auth,
                knownHostsMode,
                channel: parsed.channel,
                mode: runtimeMode,
                args: ['self', 'release-channel', 'status', '--json'],
                ...(ctx.signal ? { signal: ctx.signal } : {}),
              }));
              currentDefaultReleaseChannel = normalizePublicReleaseRingLabel(releaseStatus.defaultReleaseChannel) || null;
              managedReleaseChannels = Array.isArray(releaseStatus.managedReleaseChannels)
                ? releaseStatus.managedReleaseChannels
                : [];
            } catch {
              // The destination's canonical setup owner will return its typed
              // channel remedy if this older CLI cannot report the status.
            }
            if (currentDefaultReleaseChannel && currentDefaultReleaseChannel !== runtimeChannel) {
              const answer = await ctx.prompt({
                kind: 'releaseChannel.switchDefaultForSetup',
                stepId: 'personal_home.release_channel_preflight',
                message: `Switch the remote default release channel from ${currentDefaultReleaseChannel} to ${runtimeChannel} for this Personal Home?`,
                data: {
                  targetReleaseChannel: runtimeChannel,
                  currentDefaultReleaseChannel,
                  targetServerUrl: null,
                  managedReleaseChannels,
                },
              }) as { switchDefaultReleaseChannel?: boolean };
              if (answer.switchDefaultReleaseChannel !== true) {
                throw new SystemTaskExecutionError(
                  'release_channel_switch_declined',
                  releaseChannelSwitchDeclinedMessage({
                    currentDefaultReleaseChannel,
                    targetReleaseChannel: runtimeChannel,
                  }),
                );
              }
              switchChannel = true;
            }
          }
          ctx.emit({ type: 'progress', stepId: 'personal_home.create', message: 'Creating the remote Personal Home' });
          const raw = await deps.runPersonalHomeCommand({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
            channel: parsed.channel,
            mode: runtimeMode,
            args: [
              'home', 'create', '--yes', '--json', '--link-account', 'never',
              '--channel', runtimeChannel, '--mode', runtimeMode,
              ...(replaceServices ? ['--replace-services'] : []),
              ...(switchChannel ? ['--switch-channel'] : []),
            ],
            resultContract: 'create',
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const created = parseRemotePersonalHomeCreateResult(raw, { channel: runtimeChannel, mode: runtimeMode });
          let pairing: Readonly<
            | { kind: 'completed'; requestedDeviceLabel: string | null }
            | { kind: 'cancelled' | 'expired' | 'invalid_request' | 'update_required' | 'not_requested' }
            | { kind: 'failed'; status: number }
          > = { kind: 'not_requested' };
          if (parsed.pairDevice) {
            if (!deps.runPersonalHomePairDevice) {
              pairing = { kind: 'failed', status: 501 };
            } else {
              ctx.emit({ type: 'progress', stepId: 'personal_home.pair_device', message: 'Starting direct device pairing on the remote Home' });
              try {
                pairing = await deps.runPersonalHomePairDevice({
                  ssh: parsed.ssh,
                  auth,
                  knownHostsMode,
                  channel: parsed.channel,
                  mode: runtimeMode,
                  homeServerIdentityId: created.homeServerIdentityId,
                  args: ['home', 'pair-device', '--system-task-stream'],
                  ...(ctx.signal ? { signal: ctx.signal } : {}),
                });
              } catch {
                pairing = ctx.signal?.aborted
                  ? { kind: 'cancelled' }
                  : { kind: 'failed', status: 502 };
              }
            }
          }
          let invokingClientEnrollment: Readonly<{ kind: 'enrolled' | 'failed' | 'not_requested' }> = { kind: 'not_requested' };
          if (parsed.enrollInvokingClient) {
            if (!deps.enrollInvokingClient) {
              invokingClientEnrollment = { kind: 'failed' };
            } else {
              try {
                invokingClientEnrollment = await deps.enrollInvokingClient({
                  ssh: parsed.ssh,
                  auth,
                  knownHostsMode,
                  channel: parsed.channel,
                  descriptor: created.descriptor,
                  ...(ctx.signal ? { signal: ctx.signal } : {}),
                });
              } catch {
                invokingClientEnrollment = { kind: 'failed' };
              }
            }
          }
          return {
            action: parsed.action,
            personalHome: { ...created, pairing, invokingClientEnrollment },
          } satisfies SystemTaskJsonObject;
        }

        if (parsed.action === 'personalHome.status'
          || parsed.action === 'personalHome.backup'
          || parsed.action === 'personalHome.verifyBackup'
          || parsed.action === 'personalHome.restore'
          || parsed.action === 'personalHome.recoverRestore') {
          if (!deps.runPersonalHomeCommand) throw new SystemTaskExecutionError('unsupported', 'Remote Personal Home operations are unavailable.');
          if (!parsed.relayRuntime) throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home operation requires an explicit runtime target.');
          const runtimeChannel = parsed.relayRuntime.channel ?? 'stable';
          const runtimeMode = parsed.relayRuntime.mode ?? 'user';
          const runRemoteTask = async (
            args: readonly string[],
            input?: string,
            includeTaskSignal = true,
            timeoutMs?: number | null,
          ): Promise<SystemTaskJsonObject> => await deps.runPersonalHomeCommand!({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
            channel: parsed.channel,
            mode: runtimeMode,
            args: [...args, '--json', '--channel', runtimeChannel, '--mode', runtimeMode],
            resultContract: 'task',
            ...(input === undefined ? {} : { input }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(includeTaskSignal && ctx.signal ? { signal: ctx.signal } : {}),
          });
          const inspect = async () => parseRemotePersonalHomeStatus(await runRemoteTask(['home', 'status']));
          const withStagedArchive = async <T>(
            localPath: string,
            operation: (remotePath: string) => Promise<T>,
          ): Promise<T> => {
            if (!deps.transferPersonalHomeArchive) {
              throw new SystemTaskExecutionError('unsupported', 'Remote Personal Home archive transfer is unavailable.');
            }
            const operationId = (deps.createOperationId ?? randomUUID)();
            const prepared = parseRelocationUpload(await runRemoteTask([
              'home', 'relocation-destination', 'stage', '--operation-id', operationId, '--prepare-upload',
            ]), operationId);
            let outcome: T | undefined;
            let operationError: unknown;
            try {
              await deps.transferPersonalHomeArchive({
                ssh: parsed.ssh,
                auth,
                knownHostsMode,
                direction: 'upload',
                localPath,
                remotePath: prepared.uploadLocator,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
              });
              outcome = await operation(prepared.uploadLocator);
            } catch (error) {
              operationError = error;
            }
            try {
              await runRemoteTask(['home', 'relocation-destination', 'abort', '--operation-id', operationId], undefined, false);
            } catch {
              throw new SystemTaskExecutionError(
                'transfer_cleanup_required',
                operationError === undefined
                  ? 'Remote Personal Home transfer cleanup failed.'
                  : 'Remote Personal Home operation failed and its transfer cleanup also needs attention.',
              );
            }
            if (operationError !== undefined) throw operationError;
            if (outcome === undefined) throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home operation returned no result.');
            return outcome;
          };

          ctx.emit({ type: 'progress', stepId: 'remote.cli.install', message: 'Ensuring Happier CLI is installed' });
          await deps.installRemoteCli({ ssh: parsed.ssh, auth, knownHostsMode, channel: parsed.channel, ...(ctx.signal ? { signal: ctx.signal } : {}) });

          if (parsed.action === 'personalHome.status') {
            return { action: parsed.action, personalHome: (await inspect()).data } satisfies SystemTaskJsonObject;
          }
          if (parsed.action === 'personalHome.backup') {
            if (!deps.transferPersonalHomeArchive) throw new SystemTaskExecutionError('unsupported', 'Remote Personal Home archive transfer is unavailable.');
            const backup = parseRemotePersonalHomeBackupResult(await runRemoteTask(['home', 'backup']));
            const localPath = parsed.personalHomeOperation?.outputPath ?? resolve(basename(backup.path));
            await deps.transferPersonalHomeArchive({
              ssh: parsed.ssh,
              auth,
              knownHostsMode,
              direction: 'download',
              localPath,
              remotePath: backup.path,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            return { action: parsed.action, personalHome: { ...backup, path: localPath } } satisfies SystemTaskJsonObject;
          }
          const localArchivePath = parsed.personalHomeOperation?.archivePath;
          if (parsed.action === 'personalHome.verifyBackup') {
            if (!localArchivePath) throw new SystemTaskExecutionError('invalid_params', 'Remote backup verification requires a local archive path.');
            const verified = await withStagedArchive(localArchivePath, async (remotePath) => (
              parseRemotePersonalHomeVerification(await runRemoteTask(['home', 'verify-backup', remotePath]))
            ));
            return { action: parsed.action, personalHome: verified } satisfies SystemTaskJsonObject;
          }
          if (parsed.action === 'personalHome.restore') {
            if (!localArchivePath) throw new SystemTaskExecutionError('invalid_params', 'Remote restore requires a local archive path.');
            const restored = await withStagedArchive(localArchivePath, async (remotePath) => {
              const inspection = await inspect();
              const verified = parseRemotePersonalHomeVerification(await runRemoteTask(['home', 'verify-backup', remotePath]));
              if (verified.identityMatchesCurrentHome !== 'match'
                || verified.manifest.homeServerIdentityId !== inspection.identity.homeServerIdentityId) {
                throw new SystemTaskExecutionError('identity_mismatch', 'Backup identity does not match the remote Personal Home.');
              }
              let approvalInput: string | undefined;
              if (inspection.storage.destinationEmpty !== true) {
                const approval = createRemotePersonalHomeApproval('restore', inspection, inspection.storage.ownedErasePaths);
                const answer = await promptRemotePersonalHomeApproval(ctx, parsed.ssh.target, approval);
                if (!answer) throw new SystemTaskExecutionError('confirmation_declined', 'Remote Personal Home restore was not confirmed.');
                approvalInput = serializeRemotePersonalHomeApprovalInput(approval);
              }
              ctx.signal?.throwIfAborted();
              return parseRemotePersonalHomeMutationResult(await runRemoteTask([
                'home', 'restore', remotePath, ...(approvalInput ? ['--approval-stdin'] : []),
              ], approvalInput, false, null));
            });
            return { action: parsed.action, personalHome: restored } satisfies SystemTaskJsonObject;
          }
          const inspection = await inspect();
          if (inspection.restoreRecovery.status === 'none') {
            return { action: parsed.action, personalHome: { outcome: 'not_required' } } satisfies SystemTaskJsonObject;
          }
          if (inspection.restoreRecovery.status !== 'rollback_available' || inspection.restoreRecovery.affectedTargets.length === 0) {
            throw new SystemTaskExecutionError('restore_recovery_ambiguous', 'Remote Personal Home restore recovery is not safely actionable.');
          }
          const approval = createRemotePersonalHomeApproval('recover-restore', inspection, inspection.restoreRecovery.affectedTargets);
          if (!await promptRemotePersonalHomeApproval(ctx, parsed.ssh.target, approval)) {
            throw new SystemTaskExecutionError('confirmation_declined', 'Remote Personal Home restore recovery was not confirmed.');
          }
          ctx.signal?.throwIfAborted();
          const recovered = parseRemotePersonalHomeMutationResult(await runRemoteTask(
            ['home', 'recover-restore', '--approval-stdin'],
            serializeRemotePersonalHomeApprovalInput(approval),
            false,
            null,
          ));
          return { action: parsed.action, personalHome: recovered } satisfies SystemTaskJsonObject;
        }

        if (parsed.action === 'personalHome.erase') {
          if (!deps.runPersonalHomeCommand) throw new SystemTaskExecutionError('unsupported', 'Remote Personal Home erase is unavailable.');
          if (!parsed.relayRuntime) throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home erase requires an explicit runtime target.');
          const runtimeChannel = parsed.relayRuntime.channel ?? 'stable';
          const runtimeMode = parsed.relayRuntime.mode ?? 'user';
          ctx.emit({ type: 'progress', stepId: 'remote.cli.install', message: 'Ensuring Happier CLI is installed' });
          await deps.installRemoteCli({ ssh: parsed.ssh, auth, knownHostsMode, channel: parsed.channel, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          const inspection = parseRemotePersonalHomeInspection(await deps.runPersonalHomeCommand({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
            channel: parsed.channel,
            mode: runtimeMode,
            args: ['home', 'status', '--json', '--channel', runtimeChannel, '--mode', runtimeMode],
            resultContract: 'task',
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
          const approval: RemotePersonalHomeApprovalInput = {
            v: 1,
            operation: 'erase',
            canonicalServerUrl: inspection.canonicalServerUrl,
            homeServerIdentityId: inspection.homeServerIdentityId,
            paths: inspection.paths,
            estimatedBytes: inspection.estimatedBytes,
            confirmed: true,
          };
          const answer = await ctx.prompt({
            kind: 'personal_home.confirm_remote_erase.v1',
            stepId: 'personal_home.confirm_remote_erase',
            message: 'Confirm permanent deletion of the exact Personal Home paths on this SSH host.',
            data: {
              sshHost: parsed.ssh.target,
              canonicalServerUrl: approval.canonicalServerUrl,
              homeServerIdentityId: approval.homeServerIdentityId,
              paths: [...approval.paths],
              estimatedBytes: approval.estimatedBytes,
              previewComplete: true,
              previewReason: null,
            },
          }) as { confirmed?: unknown };
          if (answer?.confirmed !== true) {
            throw new SystemTaskExecutionError('confirmation_declined', 'Remote Personal Home erase was not confirmed.');
          }
          ctx.signal?.throwIfAborted();
          const erased = parseRemotePersonalHomeEraseResult(await deps.runPersonalHomeCommand({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
            channel: parsed.channel,
            mode: runtimeMode,
            args: ['home', 'erase', '--json', '--approval-stdin', '--channel', runtimeChannel, '--mode', runtimeMode],
            input: serializeRemotePersonalHomeApprovalInput(approval),
            resultContract: 'task',
            timeoutMs: null,
          }));
          return { action: parsed.action, personalHome: erased } satisfies SystemTaskJsonObject;
        }

        const relayRuntimeAction = resolveRelayRuntimeAction(parsed.action);
        if (relayRuntimeAction) {
          ctx.emit({
            type: 'progress',
            stepId: `relay.runtime.${relayRuntimeAction}`,
            message: 'Managing relay runtime',
          });

          const result = await deps.runRelayRuntimeCommand({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
            action: relayRuntimeAction,
            channel: parsed.relayRuntime?.channel ?? 'stable',
            mode: parsed.relayRuntime?.mode ?? 'user',
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });

          return {
            action: parsed.action,
            ...(result ? { relayRuntime: result } : {}),
          } satisfies SystemTaskJsonObject;
        }

        const daemonAction = resolveDaemonServiceAction(parsed.action);
        if (!daemonAction) {
          throw new SystemTaskExecutionError('invalid_params', 'Unsupported remote host action.');
        }

        ctx.emit({
          type: 'progress',
          stepId: 'remote.cli.install',
          message: 'Ensuring Happier CLI is installed',
        });
        await deps.installRemoteCli({
          ssh: parsed.ssh,
          auth,
          knownHostsMode,
          channel: parsed.channel,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });

        ctx.emit({
          type: 'progress',
          stepId: `daemon.service.${daemonAction}`,
          message: 'Managing background service',
        });
        await deps.runDaemonServiceCommand({
          ssh: parsed.ssh,
          auth,
          knownHostsMode,
          action: daemonAction,
          serviceMode: parsed.serviceMode,
          channel: parsed.channel,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });

        return { action: parsed.action } satisfies SystemTaskJsonObject;
      } finally {
        await cleanupTempIdentityFile?.().catch(() => {});
      }
    },
  };
}

type CanonicalRemoteHostTrustPromptKind = 'ssh.trustHost' | 'ssh.replaceHostKey';
type RemoteHostTrustPromptKind = CanonicalRemoteHostTrustPromptKind | 'sshHostTrust';

function normalizeRemoteHostTrustResolution(
  trust: Extract<RemoteHostTrustResolution, { status: 'prompt' }>,
): Extract<RemoteHostTrustResolution, { status: 'prompt' }> {
  return {
    ...trust,
    promptKind: normalizeRemoteHostTrustPromptKind(trust.promptKind as RemoteHostTrustPromptKind),
  };
}

function normalizeRemoteHostTrustPromptKind(value: RemoteHostTrustPromptKind): CanonicalRemoteHostTrustPromptKind {
  if (value === 'sshHostTrust') {
    return 'ssh.trustHost';
  }
  if (value === 'ssh.trustHost' || value === 'ssh.replaceHostKey') {
    return value;
  }
  throw new SystemTaskExecutionError('invalid_params', 'Unsupported SSH host trust prompt kind.');
}

type DaemonServiceAction = 'installOrUpdate' | 'start' | 'stop' | 'restart';

function resolveDaemonServiceAction(action: RemoteSshManageHostAction): DaemonServiceAction | null {
  if (action === 'daemonService.installOrUpdate') return 'installOrUpdate';
  if (action === 'daemonService.start') return 'start';
  if (action === 'daemonService.stop') return 'stop';
  if (action === 'daemonService.restart') return 'restart';
  return null;
}

type RelayRuntimeAction = 'status' | 'installOrUpdate' | 'start' | 'stop' | 'restart';

function resolveRelayRuntimeAction(action: RemoteSshManageHostAction): RelayRuntimeAction | null {
  if (action === 'relayRuntime.status') return 'status';
  if (action === 'relayRuntime.installOrUpdate') return 'installOrUpdate';
  if (action === 'relayRuntime.start') return 'start';
  if (action === 'relayRuntime.stop') return 'stop';
  if (action === 'relayRuntime.restart') return 'restart';
  return null;
}

async function resolveRemoteSshAuth(params: Readonly<{
  ctx: Pick<Parameters<InteractiveSystemTaskKind['run']>[0], 'prompt'>;
  ssh: SystemTaskSshConnectionConfig;
  identityPrivateKey?: string | null;
}>): Promise<Readonly<{ auth: RemoteSshAuth; cleanup: (() => Promise<void>) | null }>> {
  if (params.ssh.auth === 'password') {
    const passwordFromParams = typeof params.ssh.password === 'string' ? params.ssh.password.trim() : '';
    if (passwordFromParams) {
      return {
        auth: {
          mode: 'password',
          password: passwordFromParams,
        },
        cleanup: null,
      };
    }

    const answer = await params.ctx.prompt({
      kind: 'ssh.password',
      stepId: 'ssh.password',
      message: 'SSH password required',
      data: {
        target: params.ssh.target,
      },
    }) as { password?: unknown };
    const password = typeof answer?.password === 'string' ? answer.password.trim() : '';
    if (!password) {
      throw new SystemTaskExecutionError('password_required', 'SSH password is required.');
    }
    return {
      auth: {
        mode: 'password',
        password,
      },
      cleanup: null,
    };
  }

  if (params.ssh.auth === 'keyfile') {
    const identityFile = typeof params.ssh.identityFile === 'string' ? params.ssh.identityFile.trim() : '';
    if (identityFile) {
      return {
        auth: {
          mode: 'keyFile',
          privateKeyPath: identityFile,
        },
        cleanup: null,
      };
    }

    const privateKeyMaterial = typeof params.identityPrivateKey === 'string' ? params.identityPrivateKey.trim() : '';
    if (!privateKeyMaterial) {
      throw new SystemTaskExecutionError('invalid_params', 'Missing ssh.identityFile for keyfile auth.');
    }

    const materialized = await materializeSshIdentityPrivateKeyToTempFile({
      privateKey: privateKeyMaterial,
      prefix: 'happier-ssh-manage-host-',
    });
    return {
      auth: {
        mode: 'keyFile',
        privateKeyPath: materialized.identityFilePath,
      },
      cleanup: materialized.cleanup,
    };
  }

  return { auth: { mode: 'agent' }, cleanup: null };
}

type RemoteSshManageHostParams = Readonly<{
  action: RemoteSshManageHostAction;
  channel: 'stable' | 'preview' | 'dev';
  ssh: SystemTaskSshConnectionConfig;
  identityPrivateKey?: string;
  knownHostsMode: 'app' | 'system';
  serviceMode: 'user' | 'none';
  relayRuntime?: Readonly<{
    channel?: 'stable' | 'preview' | 'dev';
    mode?: 'user' | 'system';
  }>;
  personalHomeRelocation?: Readonly<{
    operationId: string;
    destinationMachineId: string;
    sourceDescriptorRevision: number;
    recoveryAction?: 'finish_move' | 'return_to_source';
  }>;
  personalHomeOperation?: Readonly<{ archivePath?: string; outputPath?: string }>;
  pairDevice: boolean;
  enrollInvokingClient: boolean;
  replaceServices: boolean;
  switchChannel: boolean;
}>;

function parseRemoteSshManageHostParams(params: unknown): RemoteSshManageHostParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid remote host params.');
  }
  const record = params as Record<string, unknown>;
  const actionRaw = typeof record.action === 'string' ? record.action.trim() : '';
  const action = actionRaw as RemoteSshManageHostAction;
  if (!isRemoteSshManageHostAction(action)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid remote host action.');
  }
  const sshRaw = record.ssh;
  const ssh = parseSystemTaskSshConfig(sshRaw);
  const sshRecord = sshRaw && typeof sshRaw === 'object' && !Array.isArray(sshRaw)
    ? (sshRaw as Record<string, unknown>)
    : null;
  const identityPrivateKey = sshRecord && typeof sshRecord.identityPrivateKey === 'string'
    ? sshRecord.identityPrivateKey.trim()
    : '';
  const channel = normalizePublicReleaseRingLabel(record.channel) || 'stable';
  const knownHostsMode = record.knownHostsMode === 'system' ? 'system' : 'app';
  const serviceMode = record.serviceMode === 'none' ? 'none' : 'user';
  if (record.pairDevice !== undefined && typeof record.pairDevice !== 'boolean') {
    throw new SystemTaskExecutionError('invalid_params', 'pairDevice must be a boolean.');
  }
  if (record.enrollInvokingClient !== undefined && typeof record.enrollInvokingClient !== 'boolean') {
    throw new SystemTaskExecutionError('invalid_params', 'enrollInvokingClient must be a boolean.');
  }
  if (record.replaceServices !== undefined && typeof record.replaceServices !== 'boolean') {
    throw new SystemTaskExecutionError('invalid_params', 'replaceServices must be a boolean.');
  }
  if (record.switchChannel !== undefined && typeof record.switchChannel !== 'boolean') {
    throw new SystemTaskExecutionError('invalid_params', 'switchChannel must be a boolean.');
  }
  const relayRuntimeRecord = record.relayRuntime && typeof record.relayRuntime === 'object' && !Array.isArray(record.relayRuntime)
    ? record.relayRuntime as Record<string, unknown>
    : null;
  if (action.startsWith('personalHome.') && (
    !relayRuntimeRecord
    || !normalizePublicReleaseRingLabel(relayRuntimeRecord.channel)
    || (relayRuntimeRecord.mode !== 'user' && relayRuntimeRecord.mode !== 'system')
  )) {
    throw new SystemTaskExecutionError(
      'invalid_params',
      'Remote Personal Home operation requires an explicit runtime channel and mode.',
    );
  }
  const relayRuntime = relayRuntimeRecord
    ? parseRelayRuntimeOptions(relayRuntimeRecord)
    : undefined;
  const relocationRecord = record.personalHomeRelocation && typeof record.personalHomeRelocation === 'object'
    && !Array.isArray(record.personalHomeRelocation)
    ? record.personalHomeRelocation as Record<string, unknown>
    : null;
  const personalHomeRelocation = action === 'personalHome.relocate'
    ? parsePersonalHomeRelocationOptions(relocationRecord)
    : undefined;
  const operationRecord = record.personalHomeOperation && typeof record.personalHomeOperation === 'object'
    && !Array.isArray(record.personalHomeOperation)
    ? record.personalHomeOperation as Record<string, unknown>
    : null;
  const personalHomeOperation = parsePersonalHomeOperationOptions(action, operationRecord);

  return {
    action,
    channel,
    ssh,
    ...(identityPrivateKey ? { identityPrivateKey } : {}),
    knownHostsMode,
    serviceMode,
    pairDevice: record.pairDevice === true,
    enrollInvokingClient: record.enrollInvokingClient === true,
    replaceServices: record.replaceServices === true,
    switchChannel: record.switchChannel === true,
    ...(relayRuntime ? { relayRuntime } : {}),
    ...(personalHomeRelocation ? { personalHomeRelocation } : {}),
    ...(personalHomeOperation ? { personalHomeOperation } : {}),
  };
}

function isRemoteSshManageHostAction(value: string): value is RemoteSshManageHostAction {
  return value === 'testConnection'
    || value === 'installOrUpdateCli'
    || value === 'daemonService.installOrUpdate'
    || value === 'daemonService.start'
    || value === 'daemonService.stop'
    || value === 'daemonService.restart'
    || value === 'relayRuntime.status'
    || value === 'relayRuntime.installOrUpdate'
    || value === 'relayRuntime.start'
    || value === 'relayRuntime.stop'
    || value === 'relayRuntime.restart'
    || value === 'personalHome.create'
    || value === 'personalHome.status'
    || value === 'personalHome.backup'
    || value === 'personalHome.verifyBackup'
    || value === 'personalHome.restore'
    || value === 'personalHome.recoverRestore'
    || value === 'personalHome.relocate'
    || value === 'personalHome.erase';
}

function parsePersonalHomeOperationOptions(
  action: RemoteSshManageHostAction,
  value: Record<string, unknown> | null,
): RemoteSshManageHostParams['personalHomeOperation'] | undefined {
  if (action !== 'personalHome.backup' && action !== 'personalHome.verifyBackup' && action !== 'personalHome.restore') {
    if (value) throw new SystemTaskExecutionError('invalid_params', 'This remote Personal Home action does not accept archive paths.');
    return undefined;
  }
  if (!value || Object.keys(value).some((key) => key !== 'archivePath' && key !== 'outputPath')) {
    if (action === 'personalHome.backup') return undefined;
    throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home operation requires an archive path.');
  }
  const archivePath = typeof value.archivePath === 'string' ? value.archivePath.trim() : '';
  const outputPath = typeof value.outputPath === 'string' ? value.outputPath.trim() : '';
  if ((action === 'personalHome.verifyBackup' || action === 'personalHome.restore') && (!archivePath || outputPath)) {
    throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home operation requires exactly one local archive path.');
  }
  if (action === 'personalHome.backup' && archivePath) {
    throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home backup accepts only an output path.');
  }
  return { ...(archivePath ? { archivePath } : {}), ...(outputPath ? { outputPath } : {}) };
}

function parseRemotePersonalHomeCreateResult(
  value: SystemTaskJsonObject,
  expected: Readonly<{ channel: 'stable' | 'preview' | 'dev'; mode: 'user' | 'system' }>,
): Readonly<{
  status: 'complete';
  homeServerIdentityId: string;
  canonicalServerUrl: string;
  accountCreated: boolean;
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  descriptor: HomeConnectionDescriptorV1;
}> {
  if (Object.keys(value).some((key) => key !== 'v' && key !== 'ok' && key !== 'kind' && key !== 'data')
    || value.v !== 1 || value.ok !== true || value.kind !== 'personal_home_create' || !isJsonObject(value.data)) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home creation returned the wrong result contract.');
  }
  const data = value.data;
  const allowed = new Set(['status', 'profileId', 'homeServerIdentityId', 'canonicalServerUrl', 'accountCreated', 'channel', 'mode', 'descriptor', 'accountServiceLink']);
  const accountServiceLink = isJsonObject(data.accountServiceLink) ? data.accountServiceLink : null;
  if (Object.keys(data).some((key) => !allowed.has(key))
    || data.status !== 'complete'
    || typeof data.profileId !== 'string' || !data.profileId.trim()
    || typeof data.homeServerIdentityId !== 'string' || !data.homeServerIdentityId.trim()
    || typeof data.canonicalServerUrl !== 'string' || !isLoopbackHttpUrl(data.canonicalServerUrl)
    || typeof data.accountCreated !== 'boolean'
    || data.channel !== expected.channel
    || data.mode !== expected.mode
    || !accountServiceLink
    || Object.keys(accountServiceLink).length !== 1
    || accountServiceLink.kind !== 'not_requested') {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home creation did not return exact safe completion facts.');
  }
  const descriptor = HomeConnectionDescriptorV1Schema.safeParse(data.descriptor);
  if (!descriptor.success
    || descriptor.data.homeServerIdentityId !== data.homeServerIdentityId
    || descriptor.data.canonicalServerUrl !== data.canonicalServerUrl
    || !descriptor.data.endpoints.some((endpoint) => endpoint.kind === 'iroh')) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home creation did not return an identity-matched Iroh descriptor.');
  }
  return {
    status: 'complete',
    homeServerIdentityId: data.homeServerIdentityId,
    canonicalServerUrl: data.canonicalServerUrl,
    accountCreated: data.accountCreated,
    channel: data.channel,
    mode: data.mode,
    descriptor: descriptor.data,
  };
}

function parseRemotePersonalHomeInspection(value: SystemTaskJsonObject): Readonly<{
  canonicalServerUrl: string;
  homeServerIdentityId: string;
  paths: readonly string[];
  estimatedBytes: number | null;
}> {
  const purpose = isJsonObject(value.purpose) ? value.purpose : null;
  const identity = isJsonObject(value.identity) ? value.identity : null;
  const storage = isJsonObject(value.storage) ? value.storage : null;
  const paths = Array.isArray(storage?.ownedErasePaths)
    ? storage.ownedErasePaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    : [];
  const estimatedBytes = storage?.estimatedOwnedBytes;
  const previewComplete = storage?.estimatedOwnedBytesComplete !== false;
  if (purpose?.kind !== 'personal-home'
    || typeof purpose.canonicalServerUrl !== 'string' || !purpose.canonicalServerUrl.trim()
    || typeof identity?.homeServerIdentityId !== 'string' || !identity.homeServerIdentityId.trim()
    || !Array.isArray(storage?.ownedErasePaths) || paths.length !== storage.ownedErasePaths.length || paths.length === 0
    || !previewComplete
    || (estimatedBytes !== null && (typeof estimatedBytes !== 'number' || !Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0))) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home status did not return persisted purpose, identity, and exact storage facts.');
  }
  return {
    canonicalServerUrl: purpose.canonicalServerUrl.trim(),
    homeServerIdentityId: identity.homeServerIdentityId.trim(),
    paths,
    estimatedBytes,
  };
}

type ParsedRemotePersonalHomeStatus = Readonly<{
  data: SystemTaskJsonObject;
  canonicalServerUrl: string;
  identity: Readonly<{ homeServerIdentityId: string }>;
  storage: Readonly<{
    ownedErasePaths: readonly string[];
    estimatedOwnedBytes: number | null;
    destinationEmpty: boolean;
  }>;
  restoreRecovery: Readonly<{ status: string; affectedTargets: readonly string[] }>;
}>;

function parseRemotePersonalHomeStatus(value: SystemTaskJsonObject): ParsedRemotePersonalHomeStatus {
  const purpose = isJsonObject(value.purpose) ? value.purpose : null;
  const identity = isJsonObject(value.identity) ? value.identity : null;
  const layout = isJsonObject(value.layout) ? value.layout : null;
  const storage = isJsonObject(value.storage) ? value.storage : null;
  const restoreRecovery = isJsonObject(value.restoreRecovery) ? value.restoreRecovery : null;
  const paths = Array.isArray(storage?.ownedErasePaths)
    ? storage.ownedErasePaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    : [];
  const affectedTargets = Array.isArray(restoreRecovery?.affectedTargets)
    ? restoreRecovery.affectedTargets.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    : [];
  const estimatedBytes = storage?.estimatedOwnedBytes;
  if (purpose?.kind !== 'personal-home'
    || typeof purpose.canonicalServerUrl !== 'string' || !purpose.canonicalServerUrl.trim()
    || typeof identity?.homeServerIdentityId !== 'string' || !identity.homeServerIdentityId.trim()
    || !layout
    || typeof value.running !== 'boolean'
    || !storage || !Array.isArray(storage.ownedErasePaths) || paths.length !== storage.ownedErasePaths.length
    || typeof storage.destinationEmpty !== 'boolean'
    || (estimatedBytes !== null && (typeof estimatedBytes !== 'number' || !Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0))
    || !restoreRecovery || typeof restoreRecovery.status !== 'string'
    || !Array.isArray(restoreRecovery.affectedTargets) || affectedTargets.length !== restoreRecovery.affectedTargets.length) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home status did not return persisted purpose, canonical identity, and storage facts.');
  }
  const projectedStorage: SystemTaskJsonObject = {
    ...storage,
    ownedErasePaths: paths,
    estimatedOwnedBytes: estimatedBytes,
    destinationEmpty: storage.destinationEmpty,
  };
  const projectedRecovery: SystemTaskJsonObject = { ...restoreRecovery, affectedTargets };
  return {
    data: {
      purpose: { kind: 'personal-home', canonicalServerUrl: purpose.canonicalServerUrl.trim() },
      running: value.running,
      identity: { homeServerIdentityId: identity.homeServerIdentityId.trim() },
      layout,
      storage: projectedStorage,
      restoreRecovery: projectedRecovery,
    },
    canonicalServerUrl: purpose.canonicalServerUrl.trim(),
    identity: { homeServerIdentityId: identity.homeServerIdentityId.trim() },
    storage: { ownedErasePaths: paths, estimatedOwnedBytes: estimatedBytes, destinationEmpty: storage.destinationEmpty },
    restoreRecovery: { status: restoreRecovery.status, affectedTargets },
  };
}

function parseRemotePersonalHomeManifest(value: SystemTaskJsonValue | undefined): SystemTaskJsonObject {
  if (!isJsonObject(value)
    || value.format !== 'happier-personal-home-backup'
    || value.version !== 1
    || typeof value.homeServerIdentityId !== 'string'
    || !value.homeServerIdentityId.trim()) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home archive manifest was invalid.');
  }
  return value;
}

function parseRemotePersonalHomeBackupResult(value: SystemTaskJsonObject): Readonly<{
  path: string;
  sha256: string;
  archiveBytes: number;
  manifest: SystemTaskJsonObject;
  homeNeedsAttention?: boolean;
  cleanupRequired?: Readonly<{ kind: 'backup_staging'; path: string; error: string }>;
}> {
  const cleanupRequired = isJsonObject(value.cleanupRequired) ? value.cleanupRequired : null;
  if (typeof value.path !== 'string' || !value.path.trim()
    || typeof value.sha256 !== 'string' || !value.sha256.trim()
    || typeof value.archiveBytes !== 'number' || !Number.isSafeInteger(value.archiveBytes) || value.archiveBytes < 0
    || (value.homeNeedsAttention !== undefined && typeof value.homeNeedsAttention !== 'boolean')
    || (value.cleanupRequired !== undefined && (!cleanupRequired
      || cleanupRequired.kind !== 'backup_staging'
      || typeof cleanupRequired.path !== 'string' || !cleanupRequired.path.trim()
      || typeof cleanupRequired.error !== 'string' || !cleanupRequired.error.trim()))) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home backup returned invalid archive facts.');
  }
  return {
    path: value.path.trim(),
    sha256: value.sha256.trim(),
    archiveBytes: value.archiveBytes,
    manifest: parseRemotePersonalHomeManifest(value.manifest),
    ...(value.homeNeedsAttention === undefined ? {} : { homeNeedsAttention: value.homeNeedsAttention }),
    ...(cleanupRequired ? { cleanupRequired: { kind: 'backup_staging' as const, path: String(cleanupRequired.path).trim(), error: String(cleanupRequired.error).trim() } } : {}),
  };
}

function parseRemotePersonalHomeVerification(value: SystemTaskJsonObject): SystemTaskJsonObject & Readonly<{
  identityMatchesCurrentHome: 'match' | 'mismatch' | 'unknown';
  manifest: SystemTaskJsonObject & Readonly<{ homeServerIdentityId: string }>;
}> {
  if (value.identityMatchesCurrentHome !== 'match'
    && value.identityMatchesCurrentHome !== 'mismatch'
    && value.identityMatchesCurrentHome !== 'unknown') {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home verification returned invalid identity facts.');
  }
  const manifest = parseRemotePersonalHomeManifest(value.manifest) as SystemTaskJsonObject & Readonly<{ homeServerIdentityId: string }>;
  return { ...value, manifest, identityMatchesCurrentHome: value.identityMatchesCurrentHome };
}

function parseRemotePersonalHomeMutationResult(value: SystemTaskJsonObject): SystemTaskJsonObject {
  if (typeof value.outcome !== 'string'
    || Object.keys(value).some((key) => /(?:access|bearer|credential|token|masterSecret|approval)/iu.test(key))) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home mutation returned an invalid or sensitive result.');
  }
  return value;
}

function createRemotePersonalHomeApproval(
  operation: RemotePersonalHomeApprovalInput['operation'],
  inspection: ParsedRemotePersonalHomeStatus,
  paths: readonly string[],
): RemotePersonalHomeApprovalInput {
  if (paths.length === 0) throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home operation did not identify exact affected paths.');
  return {
    v: 1,
    operation,
    canonicalServerUrl: inspection.canonicalServerUrl,
    homeServerIdentityId: inspection.identity.homeServerIdentityId,
    paths: [...paths],
    estimatedBytes: inspection.storage.estimatedOwnedBytes,
    confirmed: true,
  };
}

async function promptRemotePersonalHomeApproval(
  ctx: Parameters<InteractiveSystemTaskKind['run']>[0],
  sshHost: string,
  approval: RemotePersonalHomeApprovalInput,
): Promise<boolean> {
  const answer = await ctx.prompt({
    kind: `personal_home.confirm_remote_${approval.operation.replace('-', '_')}.v1`,
    stepId: `personal_home.confirm_remote_${approval.operation.replace('-', '_')}`,
    message: 'Confirm the exact Personal Home operation on this SSH host.',
    data: {
      sshHost,
      canonicalServerUrl: approval.canonicalServerUrl,
      homeServerIdentityId: approval.homeServerIdentityId,
      paths: [...approval.paths],
      estimatedBytes: approval.estimatedBytes,
    },
  }) as { confirmed?: unknown };
  return answer?.confirmed === true;
}

function parseRemotePersonalHomeEraseResult(value: SystemTaskJsonObject): SystemTaskJsonObject {
  const allowed = new Set(['outcome', 'removedPaths', 'remainingOwnedPaths', 'remainingUnknownPaths', 'inspectionComplete', 'inspectionError', 'error']);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || (value.outcome !== 'completed' && value.outcome !== 'completed_with_cleanup_attention' && value.outcome !== 'erased' && value.outcome !== 'partial')
    || !Array.isArray(value.removedPaths)
    || value.removedPaths.some((path) => typeof path !== 'string')) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote Personal Home erase returned an invalid result.');
  }
  return value;
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:') return false;
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function parsePersonalHomeRelocationOptions(
  value: Record<string, unknown> | null,
): NonNullable<RemoteSshManageHostParams['personalHomeRelocation']> {
  if (!value || Object.keys(value).some((key) => key !== 'operationId' && key !== 'destinationMachineId' && key !== 'sourceDescriptorRevision' && key !== 'recoveryAction')) {
    throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home relocation requires exact operation facts.');
  }
  const operationId = typeof value.operationId === 'string' ? value.operationId.trim() : '';
  const destinationMachineId = typeof value.destinationMachineId === 'string' ? value.destinationMachineId.trim() : '';
  const sourceDescriptorRevision = value.sourceDescriptorRevision;
  const recoveryAction = value.recoveryAction;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operationId) || !destinationMachineId || destinationMachineId.length > 256
    || typeof sourceDescriptorRevision !== 'number' || !Number.isSafeInteger(sourceDescriptorRevision) || sourceDescriptorRevision < 1
    || (recoveryAction !== undefined && recoveryAction !== 'finish_move' && recoveryAction !== 'return_to_source')) {
    throw new SystemTaskExecutionError('invalid_params', 'Remote Personal Home relocation requires exact operation facts.');
  }
  return { operationId, destinationMachineId, sourceDescriptorRevision, ...(recoveryAction ? { recoveryAction } : {}) };
}

function parseRelocationDescriptorPromptAnswer(value: unknown, allowNull: false): HomeConnectionDescriptorV1;
function parseRelocationDescriptorPromptAnswer(value: unknown, allowNull: true): HomeConnectionDescriptorV1 | null;
function parseRelocationDescriptorPromptAnswer(
  value: unknown,
  allowNull: boolean,
): HomeConnectionDescriptorV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'descriptor')) {
    throw new SystemTaskExecutionError('invalid_params', 'Personal Home relocation publication returned an invalid descriptor response.');
  }
  const descriptor = (value as { descriptor?: unknown }).descriptor;
  if (allowNull && descriptor === null) return null;
  const parsed = HomeConnectionDescriptorV1Schema.safeParse(descriptor);
  if (!parsed.success) {
    throw new SystemTaskExecutionError('invalid_params', 'Personal Home relocation publication returned an invalid descriptor response.');
  }
  return parsed.data;
}

function isJsonObject(value: SystemTaskJsonValue | undefined): value is SystemTaskJsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unwrapRemoteCliJsonData(value: SystemTaskJsonObject): SystemTaskJsonObject {
  return value.ok === true && isJsonObject(value.data) ? value.data : value;
}

function parseRelayRuntimeOptions(value: Record<string, unknown>): NonNullable<RemoteSshManageHostParams['relayRuntime']> {
  const channel = normalizePublicReleaseRingLabel(value.channel) || 'stable';
  const mode = value.mode === 'system' ? 'system' : 'user';
  return {
    channel,
    mode,
  };
}
