import {
    authenticateRunnerArtifactAgainstSignedChecksumsV1,
    runnerArtifactTargetPlatform,
    type VerifiedRunnerArtifactV1,
} from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { resolveReleaseArtifactArchiveName } from '@happier-dev/release-runtime/assets';
import {
    DEFAULT_MINISIGN_PUBLIC_KEY,
    resolveVerifiedReleaseArtifactDigest,
    verifyReleaseArtifactDigest,
} from '@happier-dev/release-runtime/releaseArtifactVerification';

import type { LocalUploadSource } from '@/sync/runtime/files/localUploadSourceReader';
import { createTransferManifestHasher } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher';
import {
    createRunnerArtifactAcquisitionSink,
    type RunnerArtifactAcquisitionSink,
} from './runnerArtifactAcquisitionSink';

async function readRequiredText(response: Response): Promise<string> {
    if (!response.ok) throw new Error('runner_artifact_download_unavailable');
    return await response.text();
}

/**
 * Acquire the exact server-projected immutable artifact into platform-owned
 * file custody. Discovery and trust stay outside this adapter: it follows only
 * the three authenticated publication references and verifies before return.
 */
export async function acquireRunnerArtifact(input: Readonly<{
    artifact: VerifiedRunnerArtifactV1;
    createSink?: (artifactName: string) => Promise<RunnerArtifactAcquisitionSink>;
    fetchImpl?: typeof fetch;
    minisignPublicKeyFile?: string;
    signal?: AbortSignal;
}>): Promise<Readonly<{
    artifactName: string;
    source: LocalUploadSource;
    checksumsText: string;
    checksumsSignatureFile: string;
    artifactMetadata: Readonly<{ sizeBytes: number; entries: VerifiedRunnerArtifactV1['entries'] }>;
    cleanup: () => Promise<void>;
}>> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const artifactName = new URL(input.artifact.url).pathname.split('/').at(-1) ?? '';
    if (!artifactName || decodeURIComponent(artifactName) !== artifactName || artifactName.includes('\\')) {
        throw new Error('runner_artifact_reference_invalid');
    }
    const platform = runnerArtifactTargetPlatform(input.artifact.identity.target);
    const expectedArtifactName = resolveReleaseArtifactArchiveName({
        product: input.artifact.identity.product,
        version: input.artifact.identity.version,
        os: platform.os,
        arch: platform.arch,
    });
    if (artifactName !== expectedArtifactName) throw new Error('runner_artifact_reference_invalid');
    const [checksumsText, checksumsSignatureFile] = await Promise.all([
        fetchImpl(input.artifact.checksumsUrl, { signal: input.signal }).then(readRequiredText),
        fetchImpl(input.artifact.checksumsSignatureUrl, { signal: input.signal }).then(readRequiredText),
    ]);
    // The same composite predicate the Home applies, from its one owner: the
    // creator's last-line check before executing downloaded bytes must not be
    // able to drift from the Home's.
    const trusted = authenticateRunnerArtifactAgainstSignedChecksumsV1({
        verified: resolveVerifiedReleaseArtifactDigest({ artifactName, checksumsText, checksumsSignatureFile,
            minisignPublicKeyFile: input.minisignPublicKeyFile ?? DEFAULT_MINISIGN_PUBLIC_KEY }),
        expected: {
            sha256: input.artifact.identity.sha256,
            sizeBytes: input.artifact.sizeBytes,
            entries: input.artifact.entries,
        },
    });
    if (!trusted.ok) throw new Error('runner_artifact_identity_mismatch');

    const response = await fetchImpl(input.artifact.url, { signal: input.signal });
    if (!response.ok || !response.body) throw new Error('runner_artifact_download_unavailable');
    const sink = await (input.createSink
        ? input.createSink(artifactName)
        : createRunnerArtifactAcquisitionSink({ artifactName, sizeBytes: input.artifact.sizeBytes }));
    const hasher = createTransferManifestHasher();
    let receivedBytes = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
        reader = response.body.getReader();
        while (true) {
            input.signal?.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            receivedBytes += next.value.byteLength;
            if (receivedBytes > input.artifact.sizeBytes) throw new Error('runner_artifact_size_mismatch');
            hasher.update(next.value);
            await sink.writeBytes(next.value);
        }
        if (receivedBytes !== input.artifact.sizeBytes) throw new Error('runner_artifact_size_mismatch');
        const verified = verifyReleaseArtifactDigest({ artifactName, expectedSha256: trusted.sha256,
            actualSha256: hasher.digestManifestHash().slice('sha256:'.length) });
        if (!verified.ok) throw new Error(verified.reason);
        await sink.close();
        return { artifactName, source: await sink.source(), checksumsText, checksumsSignatureFile,
            artifactMetadata: { sizeBytes: input.artifact.sizeBytes, entries: input.artifact.entries }, cleanup: sink.cleanup };
    } catch (error) {
        await reader?.cancel().catch(() => {});
        await sink.cleanup();
        throw error;
    }
}
