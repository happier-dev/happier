import {
    ComposerContentDisplayNameV1Schema,
    ComposerContentMimeTypeV1Schema,
    type ComposerContentHandleV1,
    type ComposerContentMediaKindV1,
    type PluginContributionIdentityV1,
    type SessionExecutionTargetV1,
} from '@happier-dev/protocol';

import {
    openLocalUploadSourceReader,
    type LocalUploadSource,
    type LocalUploadSourceReader,
} from '@/sync/runtime/files/localUploadSourceReader';
import {
    getComposerMediaContentAvailability,
    uploadComposerMediaStageFromReader,
    type ComposerMediaStageUploadResult,
} from '@/sync/domains/transfers/runtime/transferRuntime';
import { createTransferManifestHasher } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';
import { nativePickFiles, type NativePickedFile } from '@/utils/files/nativePickFiles';
import { sanitizePickedName } from '@/utils/files/pickedFileNormalization';

// This controls only incremental local reads before the incumbent transfer
// carrier runs; it neither rejects a user-selected media size nor changes the
// transfer protocol's target-selected chunk size.
const LOCAL_MEDIA_HASH_READ_BYTES = 64 * 1024;

type PickedComposerMediaSource = Readonly<{
    source: LocalUploadSource;
    name: string;
    mimeType: string;
}>;

function readPickedComposerMediaSource(picked: NativePickedFile): PickedComposerMediaSource {
    if (picked.kind === 'web') {
        return {
            source: { kind: 'web', file: picked.file },
            name: sanitizePickedName(picked.file.name, 'media'),
            mimeType: picked.file.type,
        };
    }
    return {
        source: { kind: 'native', uri: picked.uri, sizeBytes: picked.sizeBytes },
        name: picked.name,
        mimeType: picked.mimeType ?? '',
    };
}

function readRequestedPickerMimeTypes(
    kinds: readonly ComposerContentMediaKindV1[],
): readonly string[] {
    const allowedKinds = new Set(kinds);
    return ComposerContentMimeTypeV1Schema.options.filter((mimeType) => (
        (mimeType.startsWith('image/') && allowedKinds.has('image'))
        || (mimeType.startsWith('video/') && allowedKinds.has('video'))
    ));
}

function readRequestedMediaDescriptor(input: Readonly<{
    kinds: readonly ComposerContentMediaKindV1[];
    rawMimeType: string;
}>): Readonly<{
    mediaKind: ComposerContentMediaKindV1;
    mimeType: ReturnType<typeof ComposerContentMimeTypeV1Schema.parse>;
}> | null {
    const parsedMimeType = ComposerContentMimeTypeV1Schema.safeParse(input.rawMimeType.trim().toLowerCase());
    if (!parsedMimeType.success) return null;
    const mediaKind: ComposerContentMediaKindV1 = parsedMimeType.data.startsWith('image/') ? 'image' : 'video';
    return input.kinds.includes(mediaKind)
        ? { mediaKind, mimeType: parsedMimeType.data }
        : null;
}

function readPositiveSizeBytes(value: number | null): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : null;
}

async function readComposerMediaSha256(input: Readonly<{
    reader: LocalUploadSourceReader;
    sizeBytes: number;
    signal?: AbortSignal | null;
}>): Promise<string | null> {
    const hasher = createTransferManifestHasher();
    for (let offset = 0; offset < input.sizeBytes; offset += LOCAL_MEDIA_HASH_READ_BYTES) {
        if (input.signal?.aborted) return null;
        const length = Math.min(LOCAL_MEDIA_HASH_READ_BYTES, input.sizeBytes - offset);
        const chunk = await input.reader.readBytes(offset, length);
        if (chunk.byteLength !== length) return null;
        hasher.update(chunk);
    }
    if (input.signal?.aborted) return null;
    const digest = hasher.digestManifestHash();
    const prefix = 'sha256:';
    const sha256 = digest.startsWith(prefix) ? digest.slice(prefix.length) : '';
    return /^[a-f0-9]{64}$/u.test(sha256) ? sha256 : null;
}

/**
 * UI-origin media selection only: selected bytes flow directly from the
 * incumbent picker/source reader into the transfer-owned stage carrier. No
 * path, bytes, reader, or upload state escapes this operation.
 */
export async function pickAndStageComposerMedia(input: Readonly<{
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
    kinds: readonly ComposerContentMediaKindV1[];
    signal?: AbortSignal | null;
}>): Promise<ComposerContentHandleV1 | null> {
    if (input.signal?.aborted) return null;
    const pickerMimeTypes = readRequestedPickerMimeTypes(input.kinds);
    if (pickerMimeTypes.length === 0) return null;

    try {
        const availability = await getComposerMediaContentAvailability({
            executionTarget: input.executionTarget,
            signal: input.signal ?? null,
        });
        if (!availability.available || input.signal?.aborted) return null;

        const [picked] = await nativePickFiles({ multiple: false, type: pickerMimeTypes });
        if (!picked || input.signal?.aborted) return null;

        const source = readPickedComposerMediaSource(picked);
        const name = ComposerContentDisplayNameV1Schema.safeParse(source.name);
        const media = readRequestedMediaDescriptor({
            kinds: input.kinds,
            rawMimeType: source.mimeType,
        });
        if (!name.success || !media) return null;

        const reader = await openLocalUploadSourceReader(source.source);
        let readerClosed = false;
        const closeReaderOnce = async (): Promise<void> => {
            if (readerClosed) return;
            readerClosed = true;
            await reader.close();
        };
        try {
            const sizeBytes = readPositiveSizeBytes(reader.sizeBytes);
            if (sizeBytes === null) return null;
            const sha256 = await readComposerMediaSha256({
                reader,
                sizeBytes,
                signal: input.signal ?? null,
            });
            if (!sha256 || input.signal?.aborted) return null;
            const staged = await uploadComposerMediaStageFromReader({
                fileReader: {
                    sizeBytes,
                    readBytes: async (offset, length) => await reader.readBytes(offset, length),
                    close: closeReaderOnce,
                },
                executionTarget: input.executionTarget,
                owner: input.owner,
                mediaKind: media.mediaKind,
                mimeType: media.mimeType,
                name: name.data,
                sha256,
                signal: input.signal ?? null,
            });
            if (isTransferFinalizeRecoveryFailure<ComposerMediaStageUploadResult>(staged)) {
                const recoveryResult = await runTransferFinalizeRecovery({
                    recovery: staged.recovery,
                    title: t('transferRecovery.title'),
                    message: t('transferRecovery.message'),
                });
                return recoveryResult?.status === 'finalized'
                    ? recoveryResult.response.handle
                    : null;
            }
            return staged.success === true ? staged.handle : null;
        } finally {
            // The carrier closes the wrapped reader in its own finally. This
            // only closes a preflight failure before the carrier was reached.
            try {
                await closeReaderOnce();
            } catch {
                // The host returns its normal typed unavailable result; a local
                // source cleanup fault must not create an unhandled rejection.
            }
        }
    } catch {
        return null;
    }
}
