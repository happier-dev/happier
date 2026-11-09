import { createHash } from 'node:crypto';
import { posix, resolve, sep } from 'node:path';
import { ScmFileAtRevisionRequestSchema, type ScmFileAtRevisionRequest, type ScmFileAtRevisionResponse } from '@happier-dev/plugin-sdk/scm';

import { toRepoRootLiteralPathspec } from '../literalPathspec.js';
import { runScmCommand } from '../runtime.js';
import type { ScmBackendContext } from '../types.js';

/** Resolve mutable index/HEAD selections to one immutable object before reading its bytes. */
export async function gitFileAtRevision(input: {
    context: ScmBackendContext;
    request: ScmFileAtRevisionRequest;
    signal?: AbortSignal;
}): Promise<ScmFileAtRevisionResponse> {
    const parsed = ScmFileAtRevisionRequestSchema.safeParse(input.request);
    if (!parsed.success || !input.context.detection.isRepo) return { success: false, errorCode: 'blob_unavailable' };
    const request = parsed.data;
    const cwd = input.context.detection.rootPath ?? input.context.cwd;
    const path = posix.normalize(request.path.split(sep).join('/'));
    input.context.assertFilesystemPathAuthorized?.(resolve(cwd, path));
    const command = (args: string[], stdin?: string) => runScmCommand({ bin: 'git', cwd, args, stdin, signal: input.signal });
    const unavailable = (error?: string): ScmFileAtRevisionResponse => ({ success: false, errorCode: 'blob_unavailable', ...(error ? { error } : {}) });
    let blobId: string;
    if ('blobId' in request.selector) {
        // A claimed file path cannot bind an arbitrary object id to that file.
        // Pinned-object reads therefore consume the repository namespace grant.
        input.context.assertFilesystemPathAuthorized?.(resolve(cwd));
        blobId = request.selector.blobId;
    } else {
        const pending = request.selector.area === 'pending';
        const listing = await command(pending
            ? ['ls-files', '--stage', '-z', '--', toRepoRootLiteralPathspec(path)]
            : ['ls-tree', '-z', 'HEAD', '--', toRepoRootLiteralPathspec(path)]);
        if (!listing.success) {
            if (!pending && !input.signal?.aborted && !listing.timedOut && !listing.outputLimitExceeded) {
                // Only an absent symbolic ref proves an unborn HEAD. A damaged
                // detached object or an unreadable repository is unavailable.
                const symbolic = await command(['symbolic-ref', '--quiet', 'HEAD']);
                if (symbolic.success) {
                    const branch = await command(['show-ref', '--verify', '--quiet', symbolic.stdout.trim()]);
                    if (!branch.success && branch.exitCode === 1 && !branch.timedOut && !branch.outputLimitExceeded && !input.signal?.aborted) {
                        return { success: false, errorCode: 'not_found' };
                    }
                }
            }
            return unavailable(listing.stderr);
        }
        // With -z, the filename is literal and can itself contain tabs/newlines.
        // Match the complete identity so directory descendants cannot stand in for a file.
        let unresolved = false;
        let selected: string | undefined;
        for (const entry of listing.stdout.split('\0')) {
            const tab = entry.indexOf('\t');
            if (tab < 0 || entry.slice(tab + 1) !== path) continue;
            const metadata = entry.slice(0, tab).split(' ');
            if (pending && metadata[2] !== '0') { unresolved = true; continue; }
            selected = metadata[pending ? 1 : 2];
            break;
        }
        if (!selected) return unresolved ? unavailable() : { success: false, errorCode: 'not_found' };
        blobId = selected;
    }

    // The batch metadata query checks type and exact size together without decoding
    // content. Its stdin is one schema-validated immutable hexadecimal object id.
    const metadata = await command(['cat-file', '--batch-check=%(objecttype) %(objectsize)'], `${blobId}\n`);
    if (!metadata.success) return unavailable(metadata.stderr);
    const match = /^blob (\d+)\r?\n$/.exec(metadata.stdout);
    if (!match) return unavailable();
    const sizeBytes = Number(match[1]);
    if (!Number.isSafeInteger(sizeBytes)) return unavailable();
    if (request.maxBytes !== undefined && sizeBytes > request.maxBytes) return { success: false, errorCode: 'too_large' };

    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let received = 0;
    const content = await runScmCommand({ bin: 'git', cwd, args: ['cat-file', 'blob', blobId], signal: input.signal,
        // The known object size owns this phase's resource boundary; the generic
        // command default must not truncate a valid admitted image or restore.
        maxOutputBytes: sizeBytes,
        stdoutConsumer(chunk) {
            const bytes = Buffer.from(chunk);
            chunks.push(bytes);
            hash.update(bytes);
            received += bytes.length;
            return 'continue';
        },
    });
    if (!content.success || content.stoppedEarly || received !== sizeBytes || input.signal?.aborted) return unavailable(content.stderr);
    return { success: true, contentBase64: Buffer.concat(chunks, sizeBytes).toString('base64'), sizeBytes, sha256: hash.digest('hex') };
}
