import { fetchGitHubReleases } from '@happier-dev/release-runtime/github';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { compareVersions } from '../update/compareVersions.js';
import { getFirstPartyComponentCatalogEntry } from './componentCatalog.js';
import { resolveFirstPartyReleaseArtifactSource, type FirstPartyReleaseArtifactSource } from './releaseArtifactSource.js';

export type ManagedGuestCliReleaseErrorCode =
  | 'managed_guest_cli_release_invalid'
  | 'managed_guest_cli_release_line_mismatch'
  | 'managed_guest_cli_release_downgrade'
  | 'managed_guest_cli_release_unavailable';

export class ManagedGuestCliReleaseError extends Error {
  constructor(readonly code: ManagedGuestCliReleaseErrorCode, message: string) {
    super(message);
    this.name = 'ManagedGuestCliReleaseError';
  }
}

function readExactVersionLine(version: string): string | null {
  const match = /^(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  return match ? `${match[1]}.${match[2]}` : null;
}

function assertReleaseLine(line: string): void {
  if (!/^\d+\.\d+$/.test(line)) {
    throw new ManagedGuestCliReleaseError('managed_guest_cli_release_invalid', 'The Home CLI release line must be an explicit major.minor version.');
  }
}

function assertNoDowngrade(candidateVersion: string, installedVersion: string | undefined): void {
  if (installedVersion === undefined) return;
  if (!readExactVersionLine(installedVersion)) {
    throw new ManagedGuestCliReleaseError('managed_guest_cli_release_invalid', 'An exact CLI version is required to select an update without downgrading.');
  }
  if (compareVersions(candidateVersion, installedVersion) < 0) {
    throw new ManagedGuestCliReleaseError('managed_guest_cli_release_downgrade', `CLI ${candidateVersion} would downgrade installed CLI ${installedVersion}.`);
  }
}

/** Home-owned payloads omit line; public releases must match the Home's explicit line. */
export function assertManagedGuestCliVersion(params: Readonly<{
  line?: string;
  candidateVersion: string;
  installedVersion?: string;
}>): void {
  if (params.line !== undefined) assertReleaseLine(params.line);
  const candidateLine = readExactVersionLine(params.candidateVersion);
  if (!candidateLine) {
    throw new ManagedGuestCliReleaseError('managed_guest_cli_release_invalid', 'An exact CLI version is required to select an update without downgrading.');
  }
  if (params.line !== undefined && candidateLine !== params.line) {
    throw new ManagedGuestCliReleaseError('managed_guest_cli_release_line_mismatch', `CLI ${params.candidateVersion} does not belong to the Home release line ${params.line}.`);
  }
  assertNoDowngrade(params.candidateVersion, params.installedVersion);
}

/** Returns an exact acquisition version; the Home line, not the controller's ring, selects it. */
export async function resolveManagedGuestCliRelease(params: Readonly<{
  line: string;
  installedVersion?: string;
  /** The caller can retain its installation layout channel; it does not filter releases. */
  channel?: PublicReleaseRingId;
  artifactSource?: FirstPartyReleaseArtifactSource;
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}>): Promise<Readonly<{ versionId: string }>> {
  assertReleaseLine(params.line);
  const source = resolveFirstPartyReleaseArtifactSource(params);
  const releases = await fetchGitHubReleases({ ...source, fetchImpl: params.fetchImpl, signal: params.signal });
  const prefix = `${getFirstPartyComponentCatalogEntry('happier-cli').rollingReleasePrefix}-v`;
  let versionId: string | undefined;
  for (const release of releases) {
    if (typeof release !== 'object' || release === null || !('tag_name' in release)
      || typeof release.tag_name !== 'string' || 'draft' in release && release.draft === true
      || !release.tag_name.startsWith(prefix)) continue;
    const candidate = release.tag_name.slice(prefix.length);
    if (readExactVersionLine(candidate) !== params.line) continue;
    if (versionId === undefined || compareVersions(candidate, versionId) > 0) versionId = candidate;
  }
  if (versionId === undefined) {
    throw new ManagedGuestCliReleaseError('managed_guest_cli_release_unavailable', `No public CLI release is available for the Home release line ${params.line}.`);
  }
  assertNoDowngrade(versionId, params.installedVersion);
  return { versionId };
}
