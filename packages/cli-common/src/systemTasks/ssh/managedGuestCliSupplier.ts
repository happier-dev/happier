import { GuestCliIdentityV1Schema } from '@happier-dev/protocol/features';
import { normalizePublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { GitHubReleaseRateLimitError } from '@happier-dev/release-runtime/github';
import { assertManagedGuestCliVersion, ManagedGuestCliReleaseError, resolveManagedGuestCliRelease } from '../../firstPartyRuntime/resolveManagedGuestCliRelease.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import { quoteRemotePathWithHomeExpansion } from '../../ssh/shellQuote.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from './remoteFirstPartyInstallPath.js';
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

/** One source and version decision for controller, Account-native and SSH installs. */
export async function resolveManagedGuestCliSource(input: ManagedGuestCliSourceRequest): Promise<
  Readonly<{ kind: 'home-payload' }> | Readonly<{ kind: 'public-release'; versionId: string }>
> {
  input.signal?.throwIfAborted();
  const response = await (input.fetchImpl ?? globalThis.fetch)(`${input.homeUrl.replace(/\/+$/u, '')}/v1/features`, {
    method: 'GET', credentials: 'omit', redirect: 'error', signal: input.signal,
  });
  if (!response.ok) throw new SystemTaskExecutionError('guest_cli_identity_unavailable', `The Home guest CLI identity could not be read (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  const capabilities = body && typeof body === 'object' && 'capabilities' in body ? body.capabilities : undefined;
  const parsed = GuestCliIdentityV1Schema.safeParse(capabilities && typeof capabilities === 'object' && 'guestCli' in capabilities ? capabilities.guestCli : undefined);
  if (!parsed.success) throw new SystemTaskExecutionError('guest_cli_identity_unavailable', 'This Home does not advertise a valid guest CLI source, release line and channel.');
  const identity = parsed.data;
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
