import type { ArtifactActionInputV1, ArtifactActionResultV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { readPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';

import { saveFileBytes } from '@/sync/runtime/files/saveFileBytes';
import { sanitizeFileUriSegment } from '@/sync/runtime/files/fileUriPath';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Both the editor and automated callers export through the admitted Artifact Action. */
export async function exportArtifactToClient(
    account: LazyActionAccountContext,
    args: Extract<ArtifactActionInputV1<'artifact.export'>, { destination: 'client' }>,
    signal?: AbortSignal,
): Promise<ArtifactActionResultV1<'artifact.export'> | Readonly<{ ok: false; errorCode: string; error: string }>> {
    const artifact = await account.readArtifact(args.artifactId, { signal, prepareRecipientKeys: false });
    account.assertCurrent();
    signal?.throwIfAborted();
    if (!artifact) return { ok: false, errorCode: 'not_found', error: 'not_found' };
    if (!artifact.isDecrypted) return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    const reference = args.reference ?? artifact.body;
    if (reference == null) return { ok: false, errorCode: 'artifact_not_binary', error: 'artifact_not_binary' };
    let fileName = args.fileName ?? (artifact.title || args.artifactId);
    let bytes: Uint8Array;
    let mimeType: string;
    if (typeof reference === 'string') {
        let markdown = reference;
        if (artifact.rawHeader?.kind === 'prompt_doc.v2') {
            const document = await readPromptDocInLibrary({ artifactId: args.artifactId, signal,
                store: { read: async () => ({ id: artifact.id, header: artifact.rawHeader ?? null, body: reference,
                    revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion! } }) } });
            if (!document.ok) return document;
            markdown = document.markdown;
        }
        fileName = sanitizeFileUriSegment(/\.md$/i.test(fileName) ? fileName : `${fileName}.md`, `${args.artifactId}.md`);
        bytes = new TextEncoder().encode(markdown);
        mimeType = 'text/markdown;charset=utf-8';
    } else {
        bytes = await account.readArtifactBinary(args.artifactId, reference, signal, artifact);
        mimeType = reference.mime;
    }
    account.assertCurrent();
    signal?.throwIfAborted();
    const status = await saveFileBytes({ bytes, fileName, mimeType,
        isCurrent: () => !signal?.aborted && account.accountLifetime.isCurrent() });
    return { artifactId: args.artifactId, destination: 'client', status, fileName, sizeBytes: bytes.length };
}
