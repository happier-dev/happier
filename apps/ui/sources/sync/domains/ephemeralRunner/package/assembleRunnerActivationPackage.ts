import type { Entry } from '@zip.js/zip.js';
import { parseHappierRunnerActivationFileV1 } from '@happier-dev/protocol/ephemeralRunner/activationFile';
import { resolveRunnerPackageLayout } from '@happier-dev/protocol/ephemeralRunner/runnerPackageLayout';
import { RunnerArtifactArchiveMetadataV1Schema, type RunnerArtifactArchiveMetadataV1 } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import {
    DEFAULT_MINISIGN_PUBLIC_KEY,
    resolveVerifiedReleaseArtifactDigest,
    verifyReleaseArtifactDigest,
} from '@happier-dev/release-runtime/releaseArtifactVerification';
import { resolveArchiveSymlinkTargets } from '@happier-dev/release-runtime/archiveSymlinkContainment';

import { openLocalUploadSourceReader, type LocalUploadSource } from '@/sync/runtime/files/localUploadSourceReader';
import type { BulkTransferFileDestination } from '@/sync/domains/transfers/runtime/transferRuntime';
import { createTransferManifestHasher } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher';

const FILE_TYPE = 0o170000;
const REGULAR_FILE = 0o100000;
const DIRECTORY = 0o040000;
const SYMBOLIC_LINK = 0o120000;
// I/O scheduling buffer, not a product file-size limit.
const READ_CHUNK_BYTES = 64 * 1024;

export type RunnerPackageAssemblyInput = Readonly<{
    activationFile: unknown;
    /** Exact immutable release ZIP selected by the release artifact loader. */
    artifactName: string;
    source: LocalUploadSource;
    checksumsText: string;
    checksumsSignatureFile: string;
    artifactMetadata: RunnerArtifactArchiveMetadataV1;
    /** Locally installed trust root; never supplied by the Home projection. */
    minisignPublicKeyFile?: string;
    destination: BulkTransferFileDestination & { cleanup: () => Promise<void> };
    signal?: AbortSignal;
}>;

function fail(reason: string): never {
    // Do not include rejected activation JSON or archive entry content in errors.
    throw new Error(reason);
}

function entryPath(entry: Entry): string {
    const path = entry.directory ? entry.filename.replace(/\/$/, '') : entry.filename;
    if (!path || /[\\:\x00-\x1f\x7f]/.test(path)
        || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
        fail('runner_package_invalid_layout');
    }
    return path;
}

async function validateLayout(entries: readonly Entry[], layout: ReturnType<typeof resolveRunnerPackageLayout>): Promise<RunnerArtifactArchiveMetadataV1['entries']> {
    const bundle = layout.payloadKind === 'app-bundle';
    // Only the closed portable directory payload declares a sidecar entry; the
    // macOS core lives inside the signed bundle tree.
    const sidecarPath = layout.sidecarPath;
    const directoryRoot = bundle || sidecarPath !== undefined;
    const root = layout.payloadRootName;
    const executableName = layout.executablePath;
    const paths = new Map<string, Entry>();
    const caseFoldedPaths = new Set<string>();
    const rawLinkTargets = new Map<string, string>();
    const { TextWriter } = await import('@zip.js/zip.js');
    for (const entry of entries) {
        const path = entryPath(entry);
        const folded = path.normalize('NFC').toLowerCase();
        const mode = entry.externalFileAttributes >>> 16;
        const type = mode & FILE_TYPE;
        if (paths.has(path) || caseFoldedPaths.has(folded) || entry.encrypted
            || (mode & 0o6000) !== 0
            || (directoryRoot ? path !== root && !path.startsWith(`${root}/`) : path !== root)
            || (entry.directory ? type !== DIRECTORY && type !== 0 : ![REGULAR_FILE, SYMBOLIC_LINK, 0].includes(type))) {
            fail('runner_package_invalid_layout');
        }
        paths.set(path, entry);
        caseFoldedPaths.add(folded);
        if (type === SYMBOLIC_LINK) {
            // macOS PATH_MAX is 1024 bytes, including the terminator. Reading a
            // larger link cannot produce a usable bundle and must not allocate it.
            if (!bundle || entry.directory || entry.uncompressedSize >= 1024) fail('runner_package_invalid_link');
            const target = await entry.getData(new TextWriter(), { checkSignature: true, useWebWorkers: false, useCompressionStream: false });
            rawLinkTargets.set(path, target);
        }
    }
    const executable = paths.get(executableName);
    const executableMode = executable ? executable.externalFileAttributes >>> 16 : 0;
    if (!executable || executable.directory || rawLinkTargets.has(executableName)
        || (executableMode & 0o111) === 0
        || bundle && !paths.has(`${root}/Contents/Info.plist`)
        || !directoryRoot && paths.size !== 1) {
        fail('runner_package_invalid_layout');
    }
    // The portable payload is closed: exactly the shell executable and the core
    // sidecar the shell spawns beside it, under the one payload directory.
    if (sidecarPath !== undefined) {
        const sidecar = paths.get(sidecarPath);
        const sidecarMode = sidecar ? sidecar.externalFileAttributes >>> 16 : 0;
        const files = [...paths].filter(([, entry]) => !entry.directory).map(([path]) => path).sort();
        if (!sidecar || sidecar.directory || (sidecarMode & 0o111) === 0
            || files.join('\n') !== [executableName, sidecarPath].sort().join('\n')
            || [...paths].some(([path, entry]) => entry.directory && path !== root)) {
            fail('runner_package_invalid_layout');
        }
    }
    // Extraction must not write a file through an earlier symlink or through a
    // regular-file ancestor. Internal framework links themselves remain intact.
    for (const path of paths.keys()) {
        const parts = path.split('/');
        for (let count = 1; count < parts.length; count += 1) {
            const ancestor = paths.get(parts.slice(0, count).join('/'));
            if (ancestor && !ancestor.directory) fail('runner_package_invalid_layout');
        }
    }
    // Stepwise symlink containment is owned by release-runtime. Lexically collapsing `..`
    // before following archive-declared links cannot see chained traversal such as
    // `a/b/hop -> ../..` plus `a/b/escape -> hop/../../outside`, which stays lexically
    // in-bundle yet lands above the root once `hop` is followed first.
    let resolvedLinkTargets: Map<string, string>;
    try {
        resolvedLinkTargets = resolveArchiveSymlinkTargets(rawLinkTargets);
    } catch {
        fail('runner_package_invalid_link');
    }
    // Darwin payload policy: the shared stepwise resolver already proves extraction-root
    // containment, but links inside the signed .app must stay within the app payload
    // root itself. The canonical extractor permits contained dangling links, so no
    // target-existence check belongs here.
    if (bundle) {
        for (const finalTarget of resolvedLinkTargets.values()) {
            if (finalTarget !== root && !finalTarget.startsWith(`${root}/`)) {
                fail('runner_package_invalid_link');
            }
        }
    }
    return entries.map((entry) => {
        const path = entryPath(entry);
        const mode = entry.externalFileAttributes >>> 16;
        const type = mode & FILE_TYPE;
        const kind = entry.directory ? 'directory' as const : type === SYMBOLIC_LINK ? 'symlink' as const : 'file' as const;
        return { path, kind, sizeBytes: entry.uncompressedSize, mode: mode & 0o7777,
            ...(kind === 'symlink' ? { linkTarget: rawLinkTargets.get(path)! } : {}) };
    });
}

/**
 * Compose a closed activation ZIP into a private local sink. The source remains
 * in caller-owned immutable artifact custody; only the output is cleaned here.
 * No export is possible until this function has verified and closed the sink.
 */
export async function assembleRunnerActivationPackage(input: RunnerPackageAssemblyInput): Promise<void> {
    const activationFile = parseHappierRunnerActivationFileV1(input.activationFile);
    if (!activationFile) fail('runner_package_invalid_activation');
    const verified = resolveVerifiedReleaseArtifactDigest({
        artifactName: input.artifactName,
        checksumsText: input.checksumsText,
        checksumsSignatureFile: input.checksumsSignatureFile,
        minisignPublicKeyFile: input.minisignPublicKeyFile ?? DEFAULT_MINISIGN_PUBLIC_KEY,
    });
    if (!verified.ok) fail(verified.reason);
    if (verified.sha256 !== activationFile.activation.artifact.sha256) fail('runner_package_artifact_identity_mismatch');
    const declaredMetadata = RunnerArtifactArchiveMetadataV1Schema.safeParse(input.artifactMetadata);
    if (!declaredMetadata.success || !verified.archiveMetadata
        || JSON.stringify(verified.archiveMetadata) !== JSON.stringify(declaredMetadata.data)) {
        fail('runner_package_artifact_metadata_mismatch');
    }

    const source = await openLocalUploadSourceReader(input.source);
    let archive: InstanceType<typeof import('@zip.js/zip.js')['ZipReader']> | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    try {
        const size = source.sizeBytes;
        if (size === null || !Number.isSafeInteger(size) || size !== declaredMetadata.data.sizeBytes) fail('runner_package_artifact_size_mismatch');
        const verifySource = async () => {
            const hasher = createTransferManifestHasher();
            for (let offset = 0; offset < size; offset += READ_CHUNK_BYTES) {
                if (controller.signal.aborted) fail('runner_package_canceled');
                const length = Math.min(READ_CHUNK_BYTES, size - offset);
                const bytes = await source.readBytes(offset, length);
                if (bytes.byteLength !== length) fail('runner_package_artifact_truncated');
                hasher.update(bytes);
            }
            const digest = verifyReleaseArtifactDigest({
                artifactName: verified.artifactName,
                expectedSha256: verified.sha256,
                actualSha256: hasher.digestManifestHash().slice('sha256:'.length),
            });
            if (!digest.ok) fail(digest.reason);
        };
        await verifySource();
        // Expo's Metro bootstrap supplies native WHATWG streams.
        const { Reader, ZipReader, ZipWriter, TextReader } = await import('@zip.js/zip.js');
        class ArtifactReader extends Reader<null> {
            constructor() { super(null); this.size = size!; }
            async readUint8Array(offset: number, length: number) { return await source.readBytes(offset, length); }
        }
        archive = new ZipReader(new ArtifactReader(), { useWebWorkers: false, useCompressionStream: false });
        const entries = await archive.getEntries();
        const layout = resolveRunnerPackageLayout(activationFile.activation.artifact.target);
        const observedEntries = await validateLayout(entries, layout);
        if (JSON.stringify(observedEntries) !== JSON.stringify(declaredMetadata.data.entries)) {
            fail('runner_package_artifact_layout_mismatch');
        }

        const writer = new ZipWriter(new WritableStream<Uint8Array>({
            write: bytes => input.destination.writeBytes(bytes),
        }), { dataDescriptorSignature: true });
        const writtenDirectories = new Set<string>();
        const directories = new Map(entries.filter(entry => entry.directory).map(entry => [entryPath(entry), entry]));
        const addDirectory = async (path: string) => {
            if (writtenDirectories.has(path)) return;
            const entry = directories.get(path);
            await writer.add(`${path}/`, undefined, {
                directory: true,
                useWebWorkers: false,
                useCompressionStream: false,
                versionMadeBy: entry?.versionMadeBy ?? 0x031e,
                externalFileAttributes: entry?.externalFileAttributes ?? (0o040755 << 16),
                lastModDate: entry?.lastModDate,
                signal: controller.signal,
            });
            writtenDirectories.add(path);
        };
        for (const entry of entries) {
            const parts = entryPath(entry).split('/');
            for (let count = 1; count < parts.length; count += 1) await addDirectory(parts.slice(0, count).join('/'));
            if (entry.directory) {
                await addDirectory(entryPath(entry));
                continue;
            }
            let pipeController: TransformStreamDefaultController<Uint8Array> | undefined;
            let expandedBytes = 0;
            const pipe = new TransformStream<Uint8Array, Uint8Array>({
                start: streamController => { pipeController = streamController; },
                transform: (chunk, streamController) => {
                    expandedBytes += chunk.byteLength;
                    if (expandedBytes > entry.uncompressedSize) fail('runner_package_artifact_layout_mismatch');
                    streamController.enqueue(chunk);
                },
                flush: () => {
                    if (expandedBytes !== entry.uncompressedSize) fail('runner_package_artifact_layout_mismatch');
                },
            });
            const reading = entry.getData(pipe.writable, { checkSignature: true, signal: controller.signal });
            const streamReader = { readable: pipe.readable, size: entry.uncompressedSize };
            const writing = writer.add(entry.filename, streamReader, {
                // Stream the unchanged file bytes; storing avoids native codecs
                // and zip.js 2.7's compressed pass-through size mismatch.
                level: 0,
                useWebWorkers: false,
                useCompressionStream: false,
                versionMadeBy: entry.versionMadeBy,
                externalFileAttributes: entry.externalFileAttributes,
                internalFileAttributes: entry.internalFileAttributes,
                lastModDate: entry.lastModDate,
                signal: controller.signal,
            });
            try {
                await Promise.all([reading, writing]);
            } catch (error) {
                controller.abort();
                pipeController?.error(error);
                await Promise.allSettled([reading, writing]);
                throw error;
            }
        }
        // Catch accidental cache mutation during assembly before committing any
        // activation material or exposing output. Caller custody is immutable.
        await verifySource();
        await writer.add(layout.activationFilePath, new TextReader(JSON.stringify(activationFile)), {
            level: 0, useWebWorkers: false, useCompressionStream: false,
            versionMadeBy: 0x031e, externalFileAttributes: 0o100600 << 16, signal: controller.signal,
        });
        await writer.close();
        await input.destination.close();
    } catch (error) {
        controller.abort();
        await input.destination.cleanup();
        throw error;
    } finally {
        input.signal?.removeEventListener('abort', abort);
        await archive?.close();
        await source.close();
    }
}
