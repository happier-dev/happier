import { ScmFileReadResponseSchema, type ScmFileAtRevisionRequest, type ScmOperationErrorCode } from '@happier-dev/protocol/scm';
import { decodeBase64 } from '@/encryption/base64';
import { readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
import { digest } from '@/platform/digest';
import { machineScmFileRead } from '@/sync/ops/scm/machineScm';
import { downloadDaemonWorkspaceFileToDestination } from '@/sync/domains/transfers/runtime/transferRuntime';
import { createBufferedTransferDestination } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/createBufferedTransferDestination';
import { projectWorkspaceFileSystemRoute, workspaceFileSystemTargetFromScope } from '@/sync/ops/workspaceFileSystem/workspaceTarget';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type WorkspaceFileAtRevisionResult =
    | Readonly<{ success: true; bytes: Uint8Array; sizeBytes: number; sha256: string }>
    | Readonly<{ success: false; errorCode: ScmOperationErrorCode; error?: string }>;

/** One read client for comparison previews. Restore consumes the same backend in-process. */
export async function fetchWorkspaceFileAtRevision(input: Readonly<{
    scope: WorkspaceScopeBase;
    path: string;
    selector: ScmFileAtRevisionRequest['selector'];
    maxBytes?: number;
    signal?: AbortSignal;
}>): Promise<WorkspaceFileAtRevisionResult> {
    const target = workspaceFileSystemTargetFromScope(input.scope);
    const route = projectWorkspaceFileSystemRoute(target);
    const response = await machineScmFileRead(route.machineId, {
        cwd: route.rootPath, path: input.path, selector: input.selector,
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    }, { serverId: route.serverId, ...(target.kind === 'managed' ? { workspace: target.workspace } : {}),
        ...(input.signal ? { signal: input.signal } : {}) });
    input.signal?.throwIfAborted();
    const parsed = ScmFileReadResponseSchema.safeParse(response);
    if (!parsed.success) return { success: false, errorCode: 'blob_unavailable', error: 'The file revision response is invalid.' };
    const result = parsed.data;
    if (!result.success) return result;
    if (input.maxBytes !== undefined && result.sizeBytes > input.maxBytes) return { success: false, errorCode: 'too_large' };

    let bytes: Uint8Array;
    if ('contentBase64' in result) {
        if (readCanonicalPaddedBase64DecodedLength(result.contentBase64) !== result.sizeBytes) {
            return { success: false, errorCode: 'blob_unavailable', error: 'The revision bytes do not match their declared size.' };
        }
        bytes = decodeBase64(result.contentBase64);
    } else {
        // The transfer owner validates the manifest and resets its destination on
        // endpoint recovery. URI lifetime still belongs to the preview owner.
        const buffered = createBufferedTransferDestination(result.sizeBytes);
        const downloaded = await downloadDaemonWorkspaceFileToDestination({
            machineId: route.machineId, serverId: route.serverId,
            rootPath: route.rootPath, request: { path: input.path, asZip: false },
            signal: input.signal,
            preparedExport: result.prepared,
            onInit: async meta => {
                if (meta.sizeBytes !== result.sizeBytes || (input.maxBytes !== undefined && meta.sizeBytes > input.maxBytes)) {
                    throw new Error('The revision transfer does not match its admitted size.');
                }
            },
            destination: buffered.destination,
        });
        // An unfinished transfer says nothing about the revision; the caller may read it again.
        if (!downloaded.ok) throw new Error(downloaded.error);
        bytes = buffered.toBytes();
        buffered.reset();
    }
    input.signal?.throwIfAborted();
    const sha256 = Array.from(await digest('SHA-256', bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== result.sizeBytes || sha256 !== result.sha256) {
        return { success: false, errorCode: 'blob_unavailable', error: 'The revision bytes do not match their content hash.' };
    }
    return { success: true, bytes, sizeBytes: bytes.byteLength, sha256 };
}
