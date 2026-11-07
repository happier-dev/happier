import { ArtifactActionInputSchemasV1, ArtifactDocumentV1Schema, projectArtifactHeaderV1, type ArtifactActionInputV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { artifactSavedByFromActionContextV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { createArtifactPublicLinkActionsV1, type ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import { listArtifactHeadersV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { assembleArtifactHtmlBundleV1, isArtifactHtmlBundleEntrypointV1, prepareArtifactWorkspaceFileV1 } from '@happier-dev/protocol/artifacts/artifactWorkspaceFileV1';
import { workspaceListDirectory, type WorkspaceListDirectoryResponse } from '@/sync/ops/workspaceFileSystem/directoryBrowsing';
import { isArtifactHtmlHeaderV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
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
import { assertAccountRoleArtifactDeletionV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { DOC_EDIT_PROPOSAL_HTTP_PATHS_V1, DocEditAcceptHostInputV1Schema, DocEditAcceptTransportInputV1Schema,
    DocEditDeclineTransportInputV1Schema, DocEditDecisionResultV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { readArtifactWorkspaceSourceSessionId } from './artifactWorkspaceSource';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readMachineInventoryRowReadiness } from '@/sync/domains/machines/resolveServerScopedMachines';
import { documentFileName, saveWorkflowDocument } from '@/sync/domains/workflows/workflowDocumentFile';

/** Artifact-backed Actions use the captured Account transport and canonical sync codecs. */
export function createUiArtifactAction(account: LazyActionAccountContext, options?: Readonly<{
    onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>;
    workspaceDownload?: typeof downloadDaemonWorkspaceFileToDestination;
    /** One confined directory listing on the source machine (the daemon's filesystem Action). */
    workspaceList?: (request: Readonly<{ machineId: string; rootPath: string; agentRootPath?: string; path: string;
        signal: AbortSignal; context: ActionExecutorContext }>) => Promise<WorkspaceListDirectoryResponse & Readonly<{ truncated?: boolean }>>;
}>): NonNullable<ActionExecutorDeps['artifactAction']> {
    // Internal consumers retain exact acknowledged content; the public Action keeps its existing receipt shape.
    const createDocument = async (input: Parameters<LazyActionAccountContext['createArtifactDocument']>[0]) => {
        const { artifactId, revision } = await account.createArtifactDocument(input);
        return { artifactId, revision };
    };
    const forbidden = () => Object.assign(new Error('artifact_source_forbidden'), { code: 'artifact_source_forbidden' });
    const listDirectory = options?.workspaceList ?? (async request => await workspaceListDirectory({ machineId: request.machineId,
        rootPath: request.rootPath, agentRootPath: request.agentRootPath ?? null, serverId: account.serverId }, request.path,
        { signal: request.signal, callerContext: request.context }));
    /**
     * The confined workspace bytes behind `artifact.publish_from_file`. A file is one confined transfer;
     * an HTML folder (`entrypoint`) is every file under it through that same transfer, assembled by the
     * protocol's one bundle owner. A link, an unlisted entry or a truncated listing is refused, never skipped.
     */
    const readWorkspaceFile = async (context: ActionExecutorContext, path: string, signal?: AbortSignal,
        workspace?: ArtifactActionInputV1<'artifact.publish_from_file'>['workspace'], entrypoint?: string) => {
        account.assertCurrent();
        const sessionId = workspace ? null : readArtifactWorkspaceSourceSessionId(context);
        if ((!workspace && !sessionId) || context.runtimeAccountId !== account.accountId
            || !areServerProfileIdentifiersEquivalent(context.serverId, account.serverId))
            throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
        const resolveTarget = () => {
            if (!workspace) return sessionId ? readMachineControlTargetForSession({
                serverId: account.serverId, accountId: account.accountId, sessionId }) : null;
            const machine = resolveServerScopedMachine(storage.getState(), account.serverId, workspace.machineId);
            return machine && !machine.revokedAt && !machine.replacedByMachineId
                && readMachineInventoryRowReadiness(machine) === 'available'
                ? { machineId: machine.id, basePath: workspace.rootPath, agentBasePath: undefined } : null;
        };
        const target = resolveTarget();
        if (!target) throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
        const absolutePath = resolveMachineAbsolutePath({ rootPath: target.basePath, agentRootPath: target.agentBasePath,
            requestPath: path, pathKind: 'workspace_entry' });
        const relativePath = resolvePathRelativeToRoot({ root: target.basePath, path: absolutePath });
        if (relativePath === null || !isSafeWorkspaceRelativePath(relativePath))
            throw Object.assign(new Error('artifact_source_forbidden'), { code: 'artifact_source_forbidden' });
        if (entrypoint !== undefined && !isArtifactHtmlBundleEntrypointV1(entrypoint)) throw forbidden();
        const retirement = new AbortController();
        const stop = account.accountLifetime.onRetire(() => retirement.abort());
        const cancellation = mergeAbortSignals([retirement.signal, signal]);
        const download = async (filePath: string) => {
            // The existing producer enforces its download budget before transfer. Do not add a competing inline ceiling.
            const buffered = createBufferedTransferDestination(Number.POSITIVE_INFINITY);
            try {
                const downloaded = await (options?.workspaceDownload ?? downloadDaemonWorkspaceFileToDestination)({
                    serverId: account.serverId, machineId: target.machineId, rootPath: target.basePath,
                    agentRootPath: target.agentBasePath, request: { path: filePath, asZip: false },
                    confinedToWorkingDirectory: true, destination: buffered.destination, signal: cancellation.signal });
                account.assertCurrent();
                cancellation.signal.throwIfAborted();
                if (!downloaded.ok) throw Object.assign(new Error('artifact_source_transfer_failed'), { code: 'artifact_source_transfer_failed' });
                return { name: downloaded.name, bytes: buffered.toBytes() };
            } finally {
                buffered.reset();
            }
        };
        const readFolder = async () => {
            const files: Array<Readonly<{ key: string; bytes: Uint8Array }>> = [];
            const visit = async (directory: string): Promise<void> => {
                const listed = await listDirectory({ machineId: target.machineId, rootPath: target.basePath,
                    ...(target.agentBasePath ? { agentRootPath: target.agentBasePath } : {}), path: directory, signal: cancellation.signal, context });
                account.assertCurrent();
                cancellation.signal.throwIfAborted();
                if (!listed.success) throw Object.assign(new Error('artifact_source_transfer_failed'), { code: 'artifact_source_transfer_failed' });
                if (listed.truncated === true) throw forbidden();
                for (const entry of listed.entries) {
                    const child = `${directory}/${entry.name}`;
                    if (entry.type === 'directory') await visit(child);
                    else if (entry.type === 'file') files.push({ key: child.slice(relativePath.length + 1), bytes: (await download(child)).bytes });
                    else throw forbidden();
                }
            };
            await visit(relativePath);
            const bundle = assembleArtifactHtmlBundleV1({ entrypoint: entrypoint!, files });
            const bytes = new TextEncoder().encode(JSON.stringify(bundle));
            return { name: relativePath.split('/').at(-1) ?? relativePath, bytes, bundle };
        };
        try {
            const acquired = entrypoint === undefined ? await download(relativePath) : await readFolder();
            const current = resolveTarget();
            if (!current || current.machineId !== target.machineId || current.basePath !== target.basePath)
                throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
            const { bytes } = acquired;
            const caller = workspace ? { rootPath: target.basePath, machineId: target.machineId }
                : { sessionId: sessionId!, machineId: target.machineId, ...(context.runtimeRunId ? { runId: context.runtimeRunId } : {}) };
            return { caller,
                file: { bytes, name: acquired.name, path: relativePath, sha: hashArtifactBinaryContent(bytes),
                    ...('bundle' in acquired ? { bundle: acquired.bundle } : {}) } };
        } finally {
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
            if (!response.ok) {
                const payload: unknown = await response.json().catch(() => null);
                account.assertCurrent();
                const code = payload && typeof payload === 'object' && !Array.isArray(payload)
                    && Reflect.get(payload, 'error') === 'public_share_isolation_unavailable'
                    ? 'public_share_isolation_unavailable' : 'public_share_request_failed';
                throw Object.assign(new Error(code), { code });
            }
            return await response.json();
        },
    });
    return async invocation => {
        const { actionId, input, context, signal } = invocation;
        try {
            account.assertCurrent();
            signal?.throwIfAborted();
            const savedBy = artifactSavedByFromActionContextV1({ ...context, runtimeAccountId: account.accountId });
            switch (actionId) {
                case 'artifact.export': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    if (!('portable' in args)) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:artifact.export' };
                    const portable = args.portable;
                    const name = portable.kind === 'role' ? portable.document.name : portable.document.profile.name;
                    const fileName = documentFileName(name, portable.kind);
                    await saveWorkflowDocument({ fileName, json: JSON.stringify(portable.document, null, 2) });
                    return { exported: true, fileName };
                }
                case 'doc.edit.accept':
                case 'doc.edit.decline': {
                    const acceptInput = actionId === 'doc.edit.accept' ? DocEditAcceptHostInputV1Schema.parse(input) : undefined;
                    const args = acceptInput ?? DocEditDeclineTransportInputV1Schema.parse(input);
                    if (!areServerProfileIdentifiersEquivalent(args.proposalRef.discussion.serverId, account.serverId))
                        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
                    let body = args;
                    if (acceptInput?.preparation) {
                        const preparation = acceptInput.preparation;
                        const resource = await account.readArtifactPublicLinkResource(preparation.doc.ref.artifactId, signal, { prepareRecipientKeys: false });
                        account.assertCurrent();
                        signal?.throwIfAborted();
                        if (!resource) return { ok: false, errorCode: 'not_found', error: 'not_found' };
                        if (resource.encryptionMode === 'e2ee' && !resource.dataKey)
                            return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
                        const encodedBody = resource.encryptionMode === 'plain' ? encodePlainArtifactStoredContent({ body: preparation.body })
                            : await new ArtifactEncryption(resource.dataKey!).encryptBody({ body: preparation.body });
                        body = DocEditAcceptTransportInputV1Schema.parse({ ...acceptInput, preparation: { ...preparation, body: encodedBody } });
                    }
                    account.assertCurrent();
                    signal?.throwIfAborted();
                    let response: Response;
                    try {
                        response = await account.request(actionId === 'doc.edit.accept' ? DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.accept
                            : DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.decline, { method: 'POST', signal,
                            headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify(body) }, { includeAuth: false, retry: 'none' });
                    } catch {
                        account.assertCurrent();
                        signal?.throwIfAborted();
                        return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
                    }
                    account.assertCurrent();
                    signal?.throwIfAborted();
                    const payload: unknown = await response.json().catch(() => null);
                    account.assertCurrent();
                    signal?.throwIfAborted();
                    if (!response.ok) {
                        const code = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof Reflect.get(payload, 'error') === 'string'
                            ? String(Reflect.get(payload, 'error')) : 'action_failed';
                        return { ok: false, errorCode: code, error: code };
                    }
                    const parsed = DocEditDecisionResultV1Schema.safeParse(payload);
                    return parsed.success ? parsed.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
                }
                case 'artifact.create': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    if ('uploadPath' in args) return await createDocument({ artifactId: args.artifactId, header: args.header,
                        body: await readUpload(context, args, signal), savedBy, signal });
                    return await createDocument({ ...args, savedBy, signal });
                }
                case 'artifact.get': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    const readOnly = 'readOnly' in invocation && invocation.readOnly === true;
                    const artifact = await (readOnly ? account.readArtifact : account.fetchArtifact)(args.artifactId, { signal,
                        ...(readOnly ? { prepareRecipientKeys: false } : {}) });
                    if (!artifact) return { artifact: null };
                    if (!artifact.isDecrypted || !artifact.rawHeader || artifact.bodyVersion === undefined) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
                    return { artifact: ArtifactDocumentV1Schema.parse({ artifactId: artifact.id, header: artifact.rawHeader, body: artifact.body,
                        provenance: artifact.provenance,
                        ownerAccountId: artifact.ownerAccountId, access: artifact.access, seq: artifact.seq,
                        publicAudience: artifact.publicAudience,
                        createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
                        revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } }) };
                }
                case 'artifact.list': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    const page = await listArtifactHeadersV1({ options: { ...args, sort: args.sort ?? 'updated_desc', signal },
                        readPage: (options) => account.listArtifacts(options ?? {}), encodeCursor: account.encodeArtifactListCursor });
                    // Native document lists also carry retained body metadata. The ordinary
                    // Action publishes only its existing strict header projection.
                    const items = page.items.map(projectArtifactHeaderV1);
                    return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
                }
                case 'artifact.update': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    const result = await account.updateArtifactDocument({ ...args,
                        body: 'uploadPath' in args ? await readUpload(context, args, signal) : args.body, savedBy, signal });
                    return result.ok ? { artifactId: args.artifactId, revision: result.revision } : result;
                }
                case 'artifact.delete': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    const rawSettings = await account.readRawSettings();
                    account.assertCurrent();
                    signal?.throwIfAborted();
                    await assertAccountRoleArtifactDeletionV1({ artifactId: args.artifactId, accountId: account.accountId, rawSettings,
                        readTargetArtifactKind: async () => {
                            const target = await account.workflowArtifacts.read(args.artifactId, { signal });
                            account.assertCurrent();
                            signal?.throwIfAborted();
                            return typeof target?.header.kind === 'string' ? target.header.kind : undefined;
                        } });
                    const result = await account.workflowArtifacts.delete(args.artifactId, { expectedRevision: args.expectedRevision, signal });
                    return result.ok ? { artifactId: args.artifactId, deleted: true } : result;
                }
                case 'artifact.publish_from_file': {
                    const args = ArtifactActionInputSchemasV1[actionId].parse(input);
                    const source = await readWorkspaceFile(context, args.path, signal, args.workspace, args.entrypoint);
                    const content = prepareArtifactWorkspaceFileV1({ ...source, input: args });
                    return await createDocument({ header: content.header, body: content.binary ?? content.body, source: content.source, savedBy, signal });
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
                    return await account.restoreArtifactRevision(ArtifactActionInputSchemasV1[actionId].parse(input), signal, savedBy);
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
