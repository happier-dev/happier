import { GuestCliIdentityV1Schema, type GuestCliIdentityV1 } from '@happier-dev/protocol/features';
import type { ManagedGuestCliBuildInputV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationBuildInputV1';
import { ManagedGuestCliBuildTargetV1Schema, type ManagedGuestCliBuildTargetV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { normalizePublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { GitHubReleaseRateLimitError } from '@happier-dev/release-runtime/github';
import { assertManagedGuestCliVersion, ManagedGuestCliReleaseError, resolveManagedGuestCliRelease } from '../../firstPartyRuntime/resolveManagedGuestCliRelease.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import { quoteRemotePathWithHomeExpansion, safeBashSingleQuote } from '../../ssh/shellQuote.js';
import { buildRemoteFirstPartyPromotionCommand, resolveRemoteFirstPartyInstallLayout, resolveRemoteInstalledFirstPartyBinaryPath } from './remoteFirstPartyInstallPath.js';
import { executeRemoteSelfDownloadFirstPartyInstallPlan, resolveRemoteSelfDownloadFirstPartyInstallPlan } from './remoteSelfDownloadFirstPartyInstallCommand.js';

type RemoteText = (command: string) => Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
export type ManagedGuestCliSourceRequest = Readonly<{
  homeUrl: string;
  channel?: string;
  binaryPath: string;
  runRemoteText: RemoteText;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  localPayloadAvailable?: boolean;
  localPayloadVersion?: string;
}>;

async function readManagedGuestCliIdentity(input: Pick<ManagedGuestCliSourceRequest, 'homeUrl' | 'signal' | 'fetchImpl'>): Promise<GuestCliIdentityV1> {
  input.signal?.throwIfAborted();
  const response = await (input.fetchImpl ?? globalThis.fetch)(`${input.homeUrl.replace(/\/+$/u, '')}/v1/features`, {
    method: 'GET', credentials: 'omit', redirect: 'error', signal: input.signal,
  });
  if (!response.ok) throw new SystemTaskExecutionError('guest_cli_identity_unavailable', `The Home guest CLI identity could not be read (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  const capabilities = body && typeof body === 'object' && 'capabilities' in body ? body.capabilities : undefined;
  const parsed = GuestCliIdentityV1Schema.safeParse(capabilities && typeof capabilities === 'object' && 'guestCli' in capabilities ? capabilities.guestCli : undefined);
  if (!parsed.success) throw new SystemTaskExecutionError('guest_cli_identity_unavailable', 'This Home does not advertise a valid guest CLI source, release line and channel.');
  return parsed.data;
}

/** One source and version decision for controller, Account-native and SSH installs. */
export async function resolveManagedGuestCliSource(input: ManagedGuestCliSourceRequest): Promise<
  Readonly<{ kind: 'home-payload' }> | Readonly<{ kind: 'public-release'; versionId: string }>
> {
  const identity = await readManagedGuestCliIdentity(input);
  if (identity.source === 'home-payload' && !input.localPayloadAvailable) {
    throw new SystemTaskExecutionError('guest_payload_missing', 'This Home requires its guest CLI payload. Choose a connected controller that has the payload, then retry.');
  }
  // An unreadable existing executable is not evidence that no CLI is installed.
  const binary = quoteRemotePathWithHomeExpansion(input.binaryPath);
  const installed = await input.runRemoteText(`if [ -e ${binary} ]; then ${binary} --version; elif [ -L ${binary} ]; then exit 1; else printf '%s\\n' managed_guest_cli_absent; fi`);
  input.signal?.throwIfAborted();
  if (installed.status !== 0 || !installed.stdout.trim()) {
    throw new SystemTaskExecutionError('guest_cli_version_unavailable', 'The installed guest CLI version could not be read; installation was not changed.');
  }
  const installedVersion = installed.stdout.trim() === 'managed_guest_cli_absent' ? undefined : installed.stdout.trim();
  return await selectManagedGuestCliSource(identity, input, installedVersion);
}

async function selectManagedGuestCliSource(identity: GuestCliIdentityV1,
  input: Pick<ManagedGuestCliSourceRequest, 'localPayloadVersion' | 'signal' | 'fetchImpl'>, installedVersion?: string,
): Promise<Readonly<{ kind: 'home-payload' }> | Readonly<{ kind: 'public-release'; versionId: string }>> {
  try {
    if (identity.source === 'home-payload') {
      if (installedVersion) assertManagedGuestCliVersion({ candidateVersion: input.localPayloadVersion ?? '', installedVersion });
      return { kind: 'home-payload' };
    }
    const release = await resolveManagedGuestCliRelease({ line: identity.line, channel: identity.channel, installedVersion, signal: input.signal,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
    return { kind: 'public-release', versionId: release.versionId };
  } catch (error) {
    if (error instanceof ManagedGuestCliReleaseError || error instanceof GitHubReleaseRateLimitError) {
      throw new SystemTaskExecutionError(error.code, error.message, { cause: error });
    }
    throw error;
  }
}

export type ManagedGuestCliBuildTarget = Readonly<ManagedGuestCliBuildTargetV1>;

/** Produced from the source runtime's finalized payload identity and canonical archive. */
export type ManagedGuestCliLocalBuildPayload = Readonly<{
  identity: string;
  versionId: string;
  target: ManagedGuestCliBuildTarget;
  archive: Readonly<{ contentsBase64: string; rootDirectory: string }>;
}>;

export type ManagedGuestCliBuildInput = ManagedGuestCliBuildInputV1;

export type ManagedGuestCliLocalBuildMetadata = Pick<ManagedGuestCliLocalBuildPayload, 'identity' | 'versionId' | 'target'>;

type ManagedGuestCliBuildSourceRequest<Local extends ManagedGuestCliLocalBuildMetadata> = Readonly<{
  homeUrl: string;
  target?: Readonly<{ os: string; arch: string }>;
  readLocalPayload?: (target: ManagedGuestCliBuildTarget) => Promise<Local>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}>;

async function resolveManagedGuestCliBuildSelection<Local extends ManagedGuestCliLocalBuildMetadata>(input: ManagedGuestCliBuildSourceRequest<Local>) {
  const parsedTarget = ManagedGuestCliBuildTargetV1Schema.safeParse({ os: input.target?.os, arch: input.target?.arch });
  if (!parsedTarget.success) {
    throw new SystemTaskExecutionError('guest_architecture_unsupported', 'Preparation requires an explicit supported image OS and architecture.');
  }
  const target = parsedTarget.data;
  const identity = await readManagedGuestCliIdentity(input);
  const local = identity.source === 'home-payload' ? await input.readLocalPayload?.({ os: target.os, arch: target.arch }) : undefined;
  if (identity.source === 'home-payload' && (!local || local.target.os !== target.os || local.target.arch !== target.arch)) {
    throw new SystemTaskExecutionError('guest_payload_missing', 'The Home CLI payload for this image target is unavailable.');
  }
  const source = await selectManagedGuestCliSource(identity, input);
  return { source, channel: identity.channel, local, target,
    identity: source.kind === 'public-release' ? `public-release:${source.versionId}` : `home-payload:${local!.identity}`,
    versionId: source.kind === 'public-release' ? source.versionId : local!.versionId };
}

/** Current acquisition identity, without preparing or encoding installation files. */
export async function resolveManagedGuestCliBuildIdentity(input: Omit<ManagedGuestCliBuildSourceRequest<ManagedGuestCliLocalBuildMetadata>, 'readLocalPayload'> & Readonly<{
  readLocalPayloadMetadata?: (target: ManagedGuestCliBuildTarget) => Promise<ManagedGuestCliLocalBuildMetadata>;
}>): Promise<ManagedGuestCliLocalBuildMetadata> {
  const selection = await resolveManagedGuestCliBuildSelection({ ...input, readLocalPayload: input.readLocalPayloadMetadata });
  return { identity: selection.identity, versionId: selection.versionId, target: selection.target };
}

/** Fresh, uncredentialed image input. No guest process, enrollment or Account material is read. */
export async function prepareManagedGuestCliBuildInput(input: Readonly<{
  homeUrl: string;
  target?: Readonly<{ os: string; arch: string }>;
  prepareLocalPayload?: (target: ManagedGuestCliBuildTarget) => Promise<ManagedGuestCliLocalBuildPayload>;
  remoteHomeDir?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}>): Promise<ManagedGuestCliBuildInput> {
  const selection = await resolveManagedGuestCliBuildSelection({ ...input, readLocalPayload: input.prepareLocalPayload });
  const { source, channel, target, local } = selection;
  if (source.kind === 'public-release') {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const plan = await resolveRemoteSelfDownloadFirstPartyInstallPlan({ componentId: 'happier-cli', channel,
      versionId: source.versionId, os: target.os, arch: target.arch, remoteHomeDir: input.remoteHomeDir, fetchImpl, managedGuest: true,
      readReleaseTextAsset: async url => {
        const response = await fetchImpl(url, { credentials: 'omit', signal: input.signal });
        if (!response.ok) throw new SystemTaskExecutionError('guest_payload_missing', `The signed CLI integrity asset could not be read (HTTP ${response.status}).`);
        return await response.text();
      },
    });
    return { identity: selection.identity, versionId: plan.versionId, binaryPath: plan.binaryPath,
      installScript: plan.command, files: [] };
  }
  // The Home branch above establishes the matching owner-produced payload.
  if (!local) throw new SystemTaskExecutionError('guest_payload_missing', 'The Home CLI payload is unavailable.');
  const versionId = `local-${local.identity}`;
  const layout = resolveRemoteFirstPartyInstallLayout({ componentId: 'happier-cli', channel, versionId, remoteHomeDir: input.remoteHomeDir });
  const installScript = [
    'set -eu',
    'stage="$(mktemp -d)"',
    'trap \'rm -rf -- "$stage"\' EXIT',
    'tar -xf happier-cli-payload.tar.gz -C "$stage"',
    buildRemoteFirstPartyPromotionCommand({ layout,
      payloadRootExpression: `"$stage"/${safeBashSingleQuote(local.archive.rootDirectory)}`,
      cliInstall: { componentId: 'happier-cli', channel, versionId, managedGuest: true },
    }),
  ].join('; ');
  return { identity: selection.identity, versionId: selection.versionId, binaryPath: layout.binaryPath,
    installScript, files: [{ path: 'happier-cli-payload.tar.gz', contentsBase64: local.archive.contentsBase64 }] };
}

/** Portable transport strategy: the existing signed installer downloads on the guest. */
export async function installManagedGuestCliViaRemoteDownload(input: Readonly<{
  homeUrl: string;
  channel: string;
  os: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  remoteHomeDir?: string;
  runRemoteText: RemoteText;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}>): Promise<Readonly<{ binaryPath: string; versionId: string; source: string }>> {
  const binaryPath = resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli', channel: input.channel, remoteHomeDir: input.remoteHomeDir });
  const source = await resolveManagedGuestCliSource({ ...input, binaryPath });
  if (source.kind !== 'public-release') throw new SystemTaskExecutionError('guest_payload_missing', 'The Home guest CLI payload is unavailable to this transport.');
  input.signal?.throwIfAborted();
  const plan = await resolveRemoteSelfDownloadFirstPartyInstallPlan({ componentId: 'happier-cli', channel: normalizePublicReleaseRingId(input.channel) ?? 'stable',
    versionId: source.versionId, os: input.os, arch: input.arch, remoteHomeDir: input.remoteHomeDir,
    runRemoteText: input.runRemoteText, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
  input.signal?.throwIfAborted();
  const result = await executeRemoteSelfDownloadFirstPartyInstallPlan({ componentId: 'happier-cli', channel: input.channel, remoteHomeDir: input.remoteHomeDir,
    plan, runRemoteText: input.runRemoteText });
  if (result.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', `Guest CLI promotion failed (exit ${result.status}).`);
  return { binaryPath: plan.binaryPath, versionId: plan.versionId, source: plan.source };
}
