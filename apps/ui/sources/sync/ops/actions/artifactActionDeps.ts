import { ArtifactActionInputSchemasV1, ArtifactDocumentV1Schema, createArtifactPublicLinkActionsV1, listArtifactHeadersV1, prepareArtifactWorkspaceFileV1, isArtifactHtmlHeaderV1, type ActionExecutorContext, type ArtifactPublicLinkIssuedV1, type ActionExecutorDeps } from '@happier-dev/protocol';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { ArtifactQuotaExceededError } from '@/sync/api/artifacts/apiArtifacts';
import { HappyError } from '@/utils/errors/errors';
import type { LazyActionAccountContext } from './actionAccountContext';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { downloadDaemonWorkspaceFileToDestination } from '@/sync/domains/transfers/runtime/transferRuntime';
import { createBufferedTransferDestination } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/createBufferedTransferDestination';
import { hashArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

/** Ordinary Artifact Actions use the captured Account transport and canonical sync codecs. */
export function createUiArtifactAction(account: LazyActionAccountContext, options?: Readonly<{
    onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>;
    workspaceDownload?: typeof downloadDaemonWorkspaceFileToDestination;
}>): NonNullable<ActionExecutorDeps['artifactAction']> {
    const readWorkspaceFile = async (context: ActionExecutorContext, path: string, signal?: AbortSignal) => {
        account.assertCurrent();
        if (context.actionCaller?.kind !== 'session' || context.runtimeAccountId !== account.accountId
            || !areServerProfileIdentifiersEquivalent(context.serverId, account.serverId))
            throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
        const sessionId = context.actionCaller.sessionId;
        const target = readMachineControlTargetForSession({ serverId: account.serverId, accountId: account.accountId, sessionId });
        if (!target) throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
        const absolutePath = resolveMachineAbsolutePath({ rootPath: target.basePath, agentRootPath: target.agentBasePath, requestPath: path });
        const relativePath = resolvePathRelativeToRoot({ root: target.basePath, path: absolutePath });
        if (relativePath === null || !isSafeWorkspaceRelativePath(relativePath))
            throw Object.assign(new Error('artifact_source_forbidden'), { code: 'artifact_source_forbidden' });
        // The existing producer enforces its download budget before transfer. Do not add a competing inline ceiling.
        const buffered = createBufferedTransferDestination(Number.POSITIVE_INFINITY);
        const retirement = new AbortController();
        const stop = account.accountLifetime.onRetire(() => retirement.abort());
        const cancellation = mergeAbortSignals([retirement.signal, signal]);
        try {
            const downloaded = await (options?.workspaceDownload ?? downloadDaemonWorkspaceFileToDestination)({
                serverId: account.serverId, machineId: target.machineId, rootPath: target.basePath,
                agentRootPath: target.agentBasePath, request: { path: relativePath, asZip: false },
                confinedToWorkingDirectory: true, destination: buffered.destination, signal: cancellation.signal });
            account.assertCurrent();
            cancellation.signal.throwIfAborted();
            if (!downloaded.ok) throw Object.assign(new Error('artifact_source_transfer_failed'), { code: 'artifact_source_transfer_failed' });
            const current = readMachineControlTargetForSession({ serverId: account.serverId, accountId: account.accountId, sessionId });
            if (!current || current.machineId !== target.machineId || current.basePath !== target.basePath)
                throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
            const bytes = buffered.toBytes();
            return { caller: { sessionId, machineId: target.machineId, ...(context.runtimeRunId ? { runId: context.runtimeRunId } : {}) },
                file: { bytes, name: downloaded.name, path: relativePath, sha: hashArtifactBinaryContent(bytes) } };
        } finally {
            buffered.reset();
            cancellation.dispose();
            stop.dispose();
        }
    };
    const readUpload = async (context: ActionExecutorContext, input: Readonly<{ uploadPath: string; mime?: string; header: Readonly<Record<string, unknown>> }>, signal?: AbortSignal) => {
        const { file } = await readWorkspaceFile(context, input.uploadPath, signal);
        return { bytes: file.bytes, mime: input.mime ?? (isArtifactHtmlHeaderV1(input.header)
            ? typeof input.header.mime === 'string' ? input.header.mime : 'text/html' : 'application/octet-stream') };
    };
    const publicLinks = createArtifactPublicLinkActionsV1({
        read: account.readArtifactPublicLinkResource, randomBytes: getRandomBytes,
        onPublicLinkIssued: options?.onPublicLinkIssued,
        request: async ({ method, path, body, signal }) => {
            account.assertCurrent();
            const response = await account.request(path, { method, signal,
                headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            account.assertCurrent();
            if (!response.ok) throw Object.assign(new Error('public_share_request_failed'), { code: 'public_share_request_failed' });
            return await response.json();
        },
    });
    return async ({ actionId, input, context, signal }) => {
        try {
            account.assertCurrent();
            signal?.throwIfAborted();
            switch (actionId) {
                case 'artifact.create': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    if ('uploadPath' in args) return await account.createArtifactDocument({ artifactId: args.artifactId, header: args.header,
                        body: await readUpload(context, args, signal), signal });
                    return await account.createArtifactDocument({ ...args, signal });
                }
                case 'artifact.get': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    const artifact = await account.fetchArtifact(args.artifactId, { signal });
                    if (!artifact) return { artifact: null };
                    if (!artifact.isDecrypted || !artifact.rawHeader || artifact.bodyVersion === undefined) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
                    return { artifact: ArtifactDocumentV1Schema.parse({ artifactId: artifact.id, header: artifact.rawHeader, body: artifact.body,
                        ownerAccountId: artifact.ownerAccountId, access: artifact.access, seq: artifact.seq,
                        createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
                        revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } }), ...await account.readArtifactHtmlPreview(artifact, signal) };
                }
                case 'artifact.list': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    const page = await listArtifactHeadersV1({ options: { ...args, sort: args.sort ?? 'updated_desc', signal },
                        readPage: (options) => account.listArtifacts(options ?? {}), encodeCursor: account.encodeArtifactListCursor });
                    return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
                }
                case 'artifact.update': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    const result = await account.updateArtifactDocument({ ...args,
                        body: 'uploadPath' in args ? await readUpload(context, args, signal) : args.body, signal });
                    return result.ok ? { artifactId: args.artifactId, revision: result.revision,
                        ...(result.previewUrl ? { previewUrl: result.previewUrl } : {}), ...(result.previewError ? { previewError: result.previewError } : {}) } : result;
                }
                case 'artifact.delete': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    const result = await account.workflowArtifacts.delete(args.artifactId, { expectedRevision: args.expectedRevision, signal });
                    return result.ok ? { artifactId: args.artifactId, deleted: true } : result;
                }
                case 'artifact.publish_from_file': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    const source = await readWorkspaceFile(context, args.path, signal);
                    const content = prepareArtifactWorkspaceFileV1({ ...source, input: args });
                    return await account.createArtifactDocument({ header: content.header, body: content.binary ?? content.body, signal });
                }
                case 'artifact.public_link.create':
                case 'artifact.public_link.list':
                case 'artifact.public_link.revoke':
                case 'artifact.public_link.audit':
                    return await publicLinks({ actionId, input, signal });
                case 'artifact.revisions.list': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    return await account.listArtifactRevisions(args.artifactId, signal);
                }
                case 'artifact.revisions.restore':
                    return await account.restoreArtifactRevision(ArtifactActionInputSchemasV1[actionId].parse(input), signal);
                case 'artifact.storage.usage':
                    return await account.readArtifactStorageUsage(signal);
                default:
                    return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
            }
        } catch (error) {
            account.assertCurrent();
            signal?.throwIfAborted();
            if (error instanceof ArtifactQuotaExceededError)
                return { ok: false, errorCode: 'quota_exceeded', error: 'quota_exceeded', details: error.quota };
            const code = error instanceof HappyError && error.status === 404 ? 'not_found'
                : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'action_failed';
            return { ok: false, errorCode: code, error: error instanceof Error ? error.message : code };
        }
    };
}
