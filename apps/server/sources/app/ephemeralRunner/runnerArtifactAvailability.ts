import {
    RunnerArtifactIdentityV1Schema,
    authenticateRunnerArtifactAgainstSignedChecksumsV1,
    runnerArtifactTargetForPlatform,
    type RunnerArtifactIdentityV1,
    type RunnerArtifactTarget,
    type VerifiedRunnerArtifactV1,
} from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { isRunnerArtifactTargetEligibleForPublication } from '@happier-dev/protocol/ephemeralRunner/runnerPackageLayout';
import { getReleaseProductPublication } from '@happier-dev/release-runtime/releaseProducts';
import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';
import { fetchGitHubReleaseByTag, readGitHubReleaseHttpStatus, readGitHubReleaseFailure, resolveGitHubReleaseToken } from '@happier-dev/release-runtime/github';
import type { RunnerArtifactPublicationFailureV1 } from '@happier-dev/protocol/ephemeralRunner/errors';
import { parseReleaseManifestV1 } from '@happier-dev/release-runtime/releaseManifest';
import { DEFAULT_MINISIGN_PUBLIC_KEY, resolveVerifiedReleaseArtifactDigest } from '@happier-dev/release-runtime/releaseArtifactVerification';
import { z } from 'zod/mini';

export type RunnerArtifactUnavailableReasonV1 =
    | 'publication_unavailable'
    | 'not_published'
    | 'target_not_published'
    /**
     * The release declared eligible records for the requested target and they
     * failed verification. That is neither "temporarily unavailable metadata"
     * nor "positively absent", and reporting either would send the creator into
     * the wrong recovery.
     */
    | 'publication_invalid'
    | 'artifact_identity_mismatch';
export type RunnerArtifactAvailabilityResultV1 =
    | Readonly<{ ok: true; artifact: VerifiedRunnerArtifactV1 }>
    | Readonly<{ ok: false; reason: RunnerArtifactUnavailableReasonV1; publicationFailure?: RunnerArtifactPublicationFailureV1 }>;

export class RunnerArtifactPublicationError extends Error {
    constructor(readonly publicationFailure: RunnerArtifactPublicationFailureV1) {
        super('runner_artifact_publication_unavailable');
    }
}

export function readRunnerArtifactPublicationFailure(error: unknown): RunnerArtifactPublicationFailureV1 {
    return error instanceof RunnerArtifactPublicationError ? error.publicationFailure
        : readGitHubReleaseFailure(error) ?? { reason: 'invalid_publication' };
}

export type RunnerArtifactSourceOptions = Readonly<{
    githubToken?: string;
    version?: string;
    channel?: PublicReleaseRingId;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    minisignPublicKeyFile?: string;
    publicationSnapshots?: RunnerArtifactPublicationSnapshotStore;
}>;

export type RunnerArtifactPublicationSnapshotStore = Readonly<{
    read: (key: string) => readonly VerifiedRunnerArtifactV1[] | undefined;
    write: (key: string, artifacts: readonly VerifiedRunnerArtifactV1[]) => void;
}>;

/**
 * Owns the server-process projection of already verified release publication.
 * Exact version aliases are immutable and serve activation admission. Rolling
 * aliases re-enter the release HTTP lifecycle on every caller read, then reuse
 * an already verified exact-version snapshot when the alias still names it.
 * Failed or empty reads stay retryable; no TTL or poller creates another
 * release-currentness policy.
 */
export function createRunnerArtifactPublicationSnapshotStore(): RunnerArtifactPublicationSnapshotStore {
    const snapshots = new Map<string, readonly VerifiedRunnerArtifactV1[]>();
    return {
        read: (key) => snapshots.get(key),
        write: (key, artifacts) => snapshots.set(key, artifacts),
    };
}

export const runnerArtifactPublicationSnapshots = createRunnerArtifactPublicationSnapshotStore();

const publication = getReleaseProductPublication('happier-runner');
const ReleaseSchema = z.object({
    tag_name: z.string(), draft: z.literal(false),
    assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type RunnerArtifactPublicationRead = Readonly<{
    artifacts: readonly VerifiedRunnerArtifactV1[];
    /**
     * Targets the release declared as eligible records and whose bytes did not
     * authenticate. A retained snapshot is by definition an already verified
     * publication, so reusing one reports none.
     */
    invalidTargets: ReadonlySet<RunnerArtifactTarget>;
}>;

const NO_INVALID_TARGETS: ReadonlySet<RunnerArtifactTarget> = new Set();

async function readRunnerArtifactPublication(options: RunnerArtifactSourceOptions = {}): Promise<RunnerArtifactPublicationRead> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const repo = (process.env.HAPPIER_GITHUB_REPO ?? 'happier-dev/happier').trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { artifacts: [], invalidTargets: NO_INVALID_TARGETS };
    const ring = getReleaseRingCatalogEntry(options.channel ?? 'stable');
    if (options.version !== undefined && !RELEASE_VERSION.test(options.version)) return { artifacts: [], invalidTargets: NO_INVALID_TARGETS };
    const retained = options.version === undefined
        ? undefined
        : options.publicationSnapshots?.read(`${repo}\u0000${ring.id}\u0000${options.version}`);
    if (retained) return { artifacts: retained, invalidTargets: NO_INVALID_TARGETS };
    const requestedTag = options.version
        ? `${publication.versionTagPrefix}${options.version}`
        : `${publication.rollingTagPrefix}-${ring.rollingReleaseSuffix}`;
    const headers = { 'user-agent': 'happier-release-runtime', accept: 'application/json' };
    async function read(url: string): Promise<string> {
        options.signal?.throwIfAborted();
        try {
            const response = await fetchImpl(url, { headers, signal: options.signal });
            if (!response.ok) throw new RunnerArtifactPublicationError({
                reason: response.status === 404 ? 'not_found' : 'upstream', status: response.status,
            });
            return await response.text();
        } catch (error) {
            if (options.signal?.aborted || error instanceof RunnerArtifactPublicationError) throw error;
            throw new RunnerArtifactPublicationError({ reason: 'network' });
        }
    }
    async function load(tag: string) {
        let releaseInput: unknown;
        try {
            releaseInput = await fetchGitHubReleaseByTag({
                githubRepo: repo,
                githubToken: options.githubToken ?? resolveGitHubReleaseToken(process.env),
                tag,
                userAgent: 'happier-release-runtime',
                fetchImpl,
                signal: options.signal,
            });
        } catch (error) {
            if (readGitHubReleaseHttpStatus(error) === 404) return null;
            throw error;
        }
        const release = ReleaseSchema.parse(releaseInput);
        if (release.tag_name !== tag) throw new Error('Runner release identity mismatch');
        const assetBase = `https://github.com/${repo}/releases/download/${tag}/`;
        const names = new Set<string>();
        for (const asset of release.assets) {
            if (names.has(asset.name) || !asset.name || asset.name.includes('/') || asset.name.includes('\\')
                || asset.browser_download_url !== `${assetBase}${asset.name}`) throw new Error('Runner release asset mismatch');
            names.add(asset.name);
        }
        const manifestAsset = release.assets.find((asset) => asset.name === 'latest.json');
        if (!manifestAsset) throw new Error('Runner manifest unavailable');
        const manifest = parseReleaseManifestV1(JSON.parse(await read(manifestAsset.browser_download_url)));
        if (manifest.product !== 'happier-runner') throw new Error('Runner manifest product mismatch');
        if (manifest.channel !== ring.manifestChannel) throw new Error('Runner manifest channel mismatch');
        if (!RELEASE_VERSION.test(manifest.version)) throw new Error('Runner release version invalid');
        return { release, manifest };
    }
    try {
        let loaded = await load(requestedTag);
        if (loaded === null) return { artifacts: [], invalidTargets: NO_INVALID_TARGETS };
        const version = options.version ?? loaded.manifest.version;
        const immutableTag = `${publication.versionTagPrefix}${version}`;
        const immutableSnapshotKey = `${repo}\u0000${ring.id}\u0000${version}`;
        if (requestedTag !== immutableTag) {
            const retainedImmutable = options.publicationSnapshots?.read(immutableSnapshotKey);
            if (retainedImmutable) return { artifacts: retainedImmutable, invalidTargets: NO_INVALID_TARGETS };
            const immutable = await load(immutableTag);
            if (immutable === null) return { artifacts: [], invalidTargets: NO_INVALID_TARGETS };
            loaded = immutable;
        }
        const { release, manifest } = loaded;
        if (manifest.version !== version) return { artifacts: [], invalidTargets: NO_INVALID_TARGETS };
        const result: VerifiedRunnerArtifactV1[] = [];
        // Eligible records that exist but fail verification are not absence.
        const invalidTargets = new Set<RunnerArtifactTarget>();
        for (const record of manifest.records) {
            if (record.version !== version || record.channel !== manifest.channel) continue;
            const target = runnerArtifactTargetForPlatform(record);
            // Protocol can name future targets, but the Home exposes only the
            // intersection of release-eligible targets and exact records from the
            // verified immutable publication. Eligibility alone advertises
            // nothing, and the route remains behind the default-off product gate.
            if (target === null || !isRunnerArtifactTargetEligibleForPublication(target)) continue;
            if (record.sizeBytes === undefined || record.entries === undefined) {
                invalidTargets.add(target);
                continue;
            }
            let bundle;
            try {
                bundle = resolveReleaseAssetBundle({ assets: release.assets, product: 'happier-runner', os: record.os, arch: record.arch, preferZipOnWindows: false });
            } catch {
                invalidTargets.add(target);
                continue;
            }
            if (bundle.version !== version || record.url !== bundle.archive.url || record.signature !== bundle.checksumsSig.url) {
                invalidTargets.add(target);
                continue;
            }
            const [checksumsText, checksumsSignatureFile] = await Promise.all([read(bundle.checksums.url), read(bundle.checksumsSig.url)]);
            const authenticated = authenticateRunnerArtifactAgainstSignedChecksumsV1({
                verified: resolveVerifiedReleaseArtifactDigest({
                    artifactName: bundle.archive.name, checksumsText, checksumsSignatureFile,
                    minisignPublicKeyFile: options.minisignPublicKeyFile ?? DEFAULT_MINISIGN_PUBLIC_KEY,
                }),
                expected: { sha256: record.sha256, sizeBytes: record.sizeBytes, entries: record.entries },
            });
            if (!authenticated.ok) {
                invalidTargets.add(target);
                continue;
            }
            const identity = RunnerArtifactIdentityV1Schema.safeParse({ product: 'happier-runner', version, target, sha256: authenticated.sha256 });
            if (!identity.success) {
                invalidTargets.add(target);
                continue;
            }
            result.push({ identity: identity.data, channel: manifest.channel, url: bundle.archive.url,
                checksumsUrl: bundle.checksums.url, checksumsSignatureUrl: bundle.checksumsSig.url,
                sizeBytes: authenticated.metadata.sizeBytes, entries: authenticated.metadata.entries });
        }
        // An exact verified artifact identity is immutable. An empty projection can
        // still mean publication is in progress, so leave that retryable.
        if (result.length > 0) {
            options.publicationSnapshots?.write(immutableSnapshotKey, result);
        }
        return { artifacts: result, invalidTargets };
    } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new RunnerArtifactPublicationError(readRunnerArtifactPublicationFailure(error));
    }
}

/**
 * The existing GitHub publication carries latest.json as an untrusted index.
 * Only its same-release signed checksums can establish an artifact digest.
 * Native Runner targets remain unavailable until their release owner supplies
 * authenticated stapled-app / Authenticode evidence; manifest flags prove neither.
 */
export async function readPublishedRunnerArtifacts(options: RunnerArtifactSourceOptions = {}): Promise<readonly VerifiedRunnerArtifactV1[]> {
    return (await readRunnerArtifactPublication(options)).artifacts;
}

export async function listAvailableRunnerArtifactTargets(options: RunnerArtifactSourceOptions = {}): Promise<readonly RunnerArtifactTarget[]> {
    return (await readPublishedRunnerArtifacts(options)).map((artifact) => artifact.identity.target);
}

export async function resolveRunnerArtifactAvailability(
    identity: RunnerArtifactIdentityV1,
    options: Omit<RunnerArtifactSourceOptions, 'version'> = {},
): Promise<RunnerArtifactAvailabilityResultV1> {
    let publicationRead: RunnerArtifactPublicationRead;
    try {
        publicationRead = await readRunnerArtifactPublication({ ...options, version: identity.version });
    } catch (error) {
        return { ok: false, reason: 'publication_unavailable', publicationFailure: readRunnerArtifactPublicationFailure(error) };
    }
    const available = publicationRead.artifacts;
    // A record the release declared for this target and whose bytes did not
    // authenticate is neither absent nor temporarily unavailable. Verification
    // still failed closed above; only the reported cause changes, so the creator
    // is told the publication is broken instead of being sent to retry or to
    // wait for a target that is in fact published.
    if (publicationRead.invalidTargets.has(identity.target)) return { ok: false, reason: 'publication_invalid' };
    if (!available.length) return { ok: false, reason: 'not_published' };
    const target = available.filter((artifact) => artifact.identity.target === identity.target);
    if (!target.length) return { ok: false, reason: 'target_not_published' };
    const artifact = target.find((artifact) => artifact.identity.product === identity.product
        && artifact.identity.version === identity.version && artifact.identity.sha256 === identity.sha256);
    return artifact ? { ok: true, artifact } : { ok: false, reason: 'artifact_identity_mismatch' };
}
