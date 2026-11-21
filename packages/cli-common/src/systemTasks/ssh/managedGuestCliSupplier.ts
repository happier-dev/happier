import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { GuestCliIdentityV1Schema, type GuestCliIdentityV1, type GuestCliPayloadV1 } from '@happier-dev/protocol/features';
import type { ManagedGuestCliBuildInputV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationBuildInputV1';
import { ManagedGuestCliBuildTargetV1Schema, type ManagedGuestCliBuildTargetV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { normalizePublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { GitHubReleaseRateLimitError } from '@happier-dev/release-runtime/github';
import { assertManagedGuestCliVersion, ManagedGuestCliReleaseError, resolveManagedGuestCliRelease } from '../../firstPartyRuntime/resolveManagedGuestCliRelease.js';
import { resolveDescriptorApplicationOrigin } from '../../homeEnrollment/homeCarrierPolicy.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import { buildRemoteFirstPartyStagingCleanupCommand } from './remoteFirstPartyStagingCleanup.js';
import { quoteRemotePathWithHomeExpansion, safeBashSingleQuote } from '../../ssh/shellQuote.js';
import { REMOTE_RELEASE_ARCHITECTURES, buildRemoteFirstPartyPromotionCommand, resolveRemoteFirstPartyInstallLayout, resolveRemoteInstalledFirstPartyBinaryPath } from './remoteFirstPartyInstallPath.js';
import { buildRemoteSelfDownloadFirstPartyInstallCommand, executeRemoteSelfDownloadFirstPartyInstallPlan, resolveRemoteSelfDownloadFirstPartyInstallPlan,
  type RemoteSelfDownloadFirstPartyInstallPlan } from './remoteSelfDownloadFirstPartyInstallCommand.js';

type RemoteText = (command: string) => Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
export type ManagedGuestCliSourceRequest = Readonly<{
  homeUrl: string;
  /** Source captured by this install's admission, when supplied. */
  guestCli?: GuestCliIdentityV1;
  channel?: string;
  binaryPath: string;
  runRemoteText: RemoteText;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  localPayloadAvailable?: boolean;
  localPayloadVersion?: string;
}>;

export async function readManagedGuestCliIdentity(input: Pick<ManagedGuestCliSourceRequest, 'homeUrl' | 'signal' | 'fetchImpl'>): Promise<GuestCliIdentityV1> {
  return (await readManagedGuestCliHome(input)).identity;
}

async function readManagedGuestCliHome(input: Pick<ManagedGuestCliSourceRequest, 'homeUrl' | 'signal' | 'fetchImpl'>) {
  input.signal?.throwIfAborted();
  const response = await (input.fetchImpl ?? globalThis.fetch)(`${input.homeUrl.replace(/\/+$/u, '')}/v1/features`, {
    method: 'GET', credentials: 'omit', redirect: 'error', signal: input.signal,
  });
  if (!response.ok) throw new SystemTaskExecutionError('guest_cli_identity_unavailable', `The Home guest CLI identity could not be read (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  const capabilities = body && typeof body === 'object' && 'capabilities' in body ? body.capabilities : undefined;
  const parsed = GuestCliIdentityV1Schema.safeParse(capabilities && typeof capabilities === 'object' && 'guestCli' in capabilities ? capabilities.guestCli : undefined);
  if (!parsed.success) throw new SystemTaskExecutionError('guest_cli_identity_unavailable', 'This Home does not advertise a valid guest CLI source, release line and channel.');
  return { identity: parsed.data,
    descriptor: body && typeof body === 'object' && 'homeConnectionDescriptor' in body ? body.homeConnectionDescriptor : undefined };
}

/** Select only from this enrollment's frozen Home export; never refresh the pin beside a download. */
export function selectManagedGuestCliPayload(input: Readonly<{
  guestCli: GuestCliIdentityV1; homeUrl: string; target: ManagedGuestCliBuildTargetV1;
}>): GuestCliPayloadV1 {
  const payload = input.guestCli.source === 'home-payload' ? input.guestCli.payloads?.find(candidate =>
    candidate.target.os === input.target.os && candidate.target.arch === input.target.arch) : undefined;
  if (!payload) throw new SystemTaskExecutionError('guest_payload_missing', 'The admitted Home CLI archive for this guest target is unavailable.');
  const url = new URL(payload.url, input.homeUrl);
  if (url.origin !== new URL(input.homeUrl).origin) {
    throw new SystemTaskExecutionError('guest_payload_missing', 'The admitted CLI archive does not belong to this Home.');
  }
  return { ...payload, url: url.href };
}

/** One source and version decision for controller, Account-native and SSH installs. */
export async function resolveManagedGuestCliSource(input: ManagedGuestCliSourceRequest): Promise<
  Readonly<{ kind: 'home-payload' }> | Readonly<{ kind: 'public-release'; versionId: string }>
> {
  const identity = input.guestCli ?? await readManagedGuestCliIdentity(input);
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
  guestDownload?: Readonly<{ homeId: string }>;
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
  const { identity, descriptor } = await readManagedGuestCliHome(input);
  const { channel } = identity;
  const source = await selectManagedGuestCliSource(identity, input);
  if (source.kind === 'public-release') {
    return { ...source, channel, target, identity: `public-release:${source.versionId}` };
  }
  if (input.guestDownload) {
    const parsed = HomeConnectionDescriptorV1Schema.safeParse(descriptor);
    const guestHomeUrl = parsed.success && parsed.data.homeServerIdentityId === input.guestDownload.homeId
      ? resolveDescriptorApplicationOrigin(parsed.data, 'remote') : null;
    if (!guestHomeUrl) {
      throw new SystemTaskExecutionError('guest_payload_missing', 'This Home has no advertised HTTPS endpoint for downloading the image CLI.');
    }
    const payload = selectManagedGuestCliPayload({ guestCli: identity, homeUrl: guestHomeUrl, target });
    return { kind: 'guest-download' as const, payload, channel, target,
      identity: `home-payload:${payload.sha256}`, versionId: `local-${payload.sha256}` };
  }
  const local = await input.readLocalPayload?.(target);
  if (!local || local.target.os !== target.os || local.target.arch !== target.arch) {
    throw new SystemTaskExecutionError('guest_payload_missing', 'The Home CLI payload for this image target is unavailable.');
  }
  return { kind: 'home-payload' as const, local, channel, target,
    identity: `home-payload:${local.identity}`, versionId: local.versionId };
}

/** Current acquisition identity, without preparing or encoding installation files. */
export async function resolveManagedGuestCliBuildIdentity(input: Omit<ManagedGuestCliBuildSourceRequest<ManagedGuestCliLocalBuildMetadata>, 'readLocalPayload'> & Readonly<{
  readLocalPayloadMetadata?: (target: ManagedGuestCliBuildTarget) => Promise<ManagedGuestCliLocalBuildMetadata>;
}>): Promise<ManagedGuestCliLocalBuildMetadata> {
  const selection = await resolveManagedGuestCliBuildSelection({ ...input, readLocalPayload: input.readLocalPayloadMetadata });
  return { identity: selection.identity, versionId: selection.versionId, target: selection.target };
}

/** Fresh, uncredentialed image input. No guest process, enrollment or Account material is read. */
export async function prepareManagedGuestCliBuildInput(input: Omit<ManagedGuestCliBuildSourceRequest<ManagedGuestCliLocalBuildPayload>, 'readLocalPayload'> & Readonly<{
  prepareLocalPayload?: (target: ManagedGuestCliBuildTarget) => Promise<ManagedGuestCliLocalBuildPayload>;
  remoteHomeDir?: string;
}>): Promise<ManagedGuestCliBuildInput> {
  const selection = await resolveManagedGuestCliBuildSelection({ ...input, readLocalPayload: input.prepareLocalPayload });
  const { channel, target } = selection;
  if (selection.kind === 'public-release') {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const plan = await resolveRemoteSelfDownloadFirstPartyInstallPlan({ componentId: 'happier-cli', channel,
      versionId: selection.versionId, os: target.os, arch: target.arch, remoteHomeDir: input.remoteHomeDir, fetchImpl, managedGuest: true,
      readReleaseTextAsset: async url => {
        const response = await fetchImpl(url, { credentials: 'omit', signal: input.signal });
        if (!response.ok) throw new SystemTaskExecutionError('managed_guest_cli_release_unavailable', `The signed CLI integrity asset could not be read (HTTP ${response.status}).`);
        return await response.text();
      },
    });
    return { identity: selection.identity, versionId: plan.versionId, binaryPath: plan.binaryPath,
      installScript: plan.command, files: [] };
  }
  if (selection.kind === 'guest-download') {
    const plan = buildManagedGuestCliPayloadInstallPlan({ guestCliPayload: selection.payload, channel, remoteHomeDir: input.remoteHomeDir });
    return { identity: selection.identity, versionId: plan.versionId, binaryPath: plan.binaryPath,
      installScript: plan.command, files: [] };
  }
  const { local } = selection;
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

/** Consumers with this installer can use the Home's pinned export without a controller. */
export const MANAGED_GUEST_CLI_REMOTE_PAYLOAD_CAPABILITIES = { remotePayloadAvailable: true } as const;

/** One pinned-archive plan for managed installs and copied personal setup commands. */
function buildManagedGuestCliPayloadInstallPlan(input: Readonly<{
  guestCliPayload: GuestCliPayloadV1;
  channel: string;
  remoteHomeDir?: string;
  managedGuest?: boolean;
  archivePath?: string;
}>): RemoteSelfDownloadFirstPartyInstallPlan {
  const payload = input.guestCliPayload;
  const versionId = `local-${payload.sha256}`;
  return {
    binaryPath: resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli', channel: input.channel, remoteHomeDir: input.remoteHomeDir }),
    versionId, source: 'home-payload', command: buildRemoteSelfDownloadFirstPartyInstallCommand({
      componentId: 'happier-cli', channel: input.channel, versionId, remoteHomeDir: input.remoteHomeDir,
      managedGuest: input.managedGuest ?? true,
      archive: { name: `happier-${payload.target.os}-${payload.target.arch}.tar.gz`, url: payload.url },
      expectedSha256: payload.sha256,
      ...(input.archivePath ? { archivePath: input.archivePath } : {}),
    }),
  };
}

/** Prepare the pinned installer before the caller supplies its shell-quoted CLI arguments. */
export function prepareManagedGuestCliPayloadInstallAndRunCommand(input: Readonly<{
  homeUrl: string;
  guestCli: GuestCliIdentityV1;
  os: 'linux' | 'darwin';
}>): ((runCommand: string) => string) | null {
  const payloads = input.guestCli.payloads?.filter(payload => payload.target.os === input.os) ?? [];
  if (!payloads.length) return null;
  const branches = payloads.map(payload => {
    const selected = selectManagedGuestCliPayload({ guestCli: input.guestCli, homeUrl: input.homeUrl, target: payload.target });
    const plan = buildManagedGuestCliPayloadInstallPlan({ guestCliPayload: selected, channel: input.guestCli.channel, managedGuest: false });
    const architecture = REMOTE_RELEASE_ARCHITECTURES.find(target => target.arch === payload.target.arch)!;
    const pattern = architecture.aliases.map(alias => `*${input.os}*/${alias}`).join('|');
    // The install subshell settles its staging cleanup before invoking personal setup.
    return `${pattern}) (${plan.command}) && exec ${quoteRemotePathWithHomeExpansion(plan.binaryPath)}`;
  });
  return runCommand => `(case "$(uname -s | tr '[:upper:]' '[:lower:]')/$(uname -m | tr '[:upper:]' '[:lower:]')" in ${branches.map(branch => `${branch} ${runCommand} ;;`).join(' ')} *) printf '%s\\n' guest_payload_missing >&2; exit 1 ;; esac)`;
}

/** The invoking host fetches admitted Home archives; the guest verifies before promotion. */
export async function installManagedGuestCliViaRemoteDownload(input: Readonly<{
  homeUrl: string;
  channel: string;
  os: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  remoteHomeDir?: string;
  runRemoteText: RemoteText;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onPromote?(): void;
  /** Existing file/exec transport; no Home HTTP client is required on the guest. */
  transferArchive?: (input: Readonly<{ path: string; chunks: AsyncIterable<Uint8Array> }>) => Promise<void>;
  /** The admitted source-Home snapshot; this supplier selects its probed target once. */
  guestCli?: GuestCliIdentityV1;
}>): Promise<Readonly<{ binaryPath: string; versionId: string; source: string }>> {
  const binaryPath = resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli', channel: input.channel, remoteHomeDir: input.remoteHomeDir });
  input.signal?.throwIfAborted();
  const guestCli = input.guestCli ?? await readManagedGuestCliIdentity(input);
  const guestCliPayload = guestCli.source === 'home-payload'
    ? selectManagedGuestCliPayload({ guestCli, homeUrl: input.homeUrl, target: { os: input.os, arch: input.arch } }) : undefined;
  let uploadedStage: string | undefined;
  try {
    let plan: RemoteSelfDownloadFirstPartyInstallPlan;
    if (guestCliPayload) {
      if (!input.transferArchive) throw new SystemTaskExecutionError('guest_payload_missing', 'The admitted install transport cannot deliver this Home archive.');
      const layout = resolveRemoteFirstPartyInstallLayout({ componentId: 'happier-cli', channel: input.channel,
        versionId: `local-${guestCliPayload.sha256}`, remoteHomeDir: input.remoteHomeDir });
      const staged = await input.runRemoteText(`mkdir -p ${quoteRemotePathWithHomeExpansion(layout.remoteHomeDir)} || exit $?; mktemp -d ${quoteRemotePathWithHomeExpansion(`${layout.remoteHomeDir}/bootstrap-upload.XXXXXXXX`)}`);
      if (staged.status !== 0 || !staged.stdout.trim()) throw new SystemTaskExecutionError('remote_command_failed', 'Guest CLI archive staging failed.');
      uploadedStage = staged.stdout.trim();
      const archivePath = `${uploadedStage}/archive`;
      // The controller reaches its selected Home. Only the admitted archive bytes,
      // never a controller-local URL, cross the guest's existing install channel.
      const response = await (input.fetchImpl ?? globalThis.fetch)(guestCliPayload.url, {
        credentials: 'omit', redirect: 'error', signal: input.signal,
      });
      if (!response.ok) throw new SystemTaskExecutionError('guest_payload_missing', `The admitted Home CLI archive could not be read (HTTP ${response.status}).`);
      await input.transferArchive({ path: archivePath, chunks: readArchiveChunks(response) });
      input.signal?.throwIfAborted();
      plan = buildManagedGuestCliPayloadInstallPlan({ guestCliPayload,
        channel: input.channel, remoteHomeDir: input.remoteHomeDir, archivePath });
    } else {
      const source = await resolveManagedGuestCliSource({ ...input, guestCli, binaryPath });
      if (source.kind !== 'public-release') throw new SystemTaskExecutionError('guest_payload_missing', 'The Home guest CLI payload is unavailable to this transport.');
      plan = await resolveRemoteSelfDownloadFirstPartyInstallPlan({ componentId: 'happier-cli', channel: normalizePublicReleaseRingId(input.channel) ?? 'stable',
        versionId: source.versionId, os: input.os, arch: input.arch, remoteHomeDir: input.remoteHomeDir,
        runRemoteText: input.runRemoteText, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
    }
    input.signal?.throwIfAborted();
    input.onPromote?.();
    const result = await executeRemoteSelfDownloadFirstPartyInstallPlan({ componentId: 'happier-cli', channel: input.channel, remoteHomeDir: input.remoteHomeDir,
      plan, runRemoteText: input.runRemoteText });
    if (result.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', `Guest CLI promotion failed (exit ${result.status}).`);
    return { binaryPath: plan.binaryPath, versionId: plan.versionId, source: plan.source };
  } finally {
    if (uploadedStage) await input.runRemoteText(buildRemoteFirstPartyStagingCleanupCommand(safeBashSingleQuote(uploadedStage))).catch(() => undefined);
  }
}

async function* readArchiveChunks(response: Response): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    yield new Uint8Array(await response.arrayBuffer());
    return;
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
