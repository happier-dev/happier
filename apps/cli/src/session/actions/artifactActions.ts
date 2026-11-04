import type { ArtifactSignedInLinkOpenedV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import { ArtifactActionInputSchemasV1, projectArtifactHeaderV1, type ArtifactActionInputV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { artifactSavedByFromActionContextV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { isArtifactHtmlHeaderV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { getArtifactKindPolicyV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import type { ActionExecutorContext, ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol';
import { DocEditAcceptHostInputV1Schema, DocEditDeclineInputV1Schema, type ArtifactHostActionInvocationV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import type { createAccountArtifactStore, ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { publishArtifactFromWorkspaceFile, readArtifactWorkspaceFile, writeArtifactWorkspaceFile,
  type ArtifactWorkspaceCaller } from './publishArtifactFromWorkspaceFile';

type WorkspaceSource = NonNullable<ArtifactActionInputV1<'artifact.publish_from_file'>['workspace']>;

/** Account content stays in the existing Artifact store; only the host resolves publication authority. */
export function createCliArtifactActions(params: Readonly<{
  store: ReturnType<typeof createAccountArtifactStore>;
  beforeDelete: (input: Readonly<{ artifactId: string; signal?: AbortSignal }>) => Promise<void>;
  resolvePublishCaller: (context: ActionExecutorContext, workspace?: WorkspaceSource) => Promise<ArtifactWorkspaceCaller | null>;
  forwardWorkspacePublication?: (input: ArtifactActionInputV1<'artifact.publish_from_file'> & Readonly<{ workspace: WorkspaceSource }>,
    context: ActionExecutorContext, signal?: AbortSignal) => Promise<unknown>;
  onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>;
  consumeArtifactSignedInLinkSecret?: (lookupId: string) => Promise<string | null>;
  onArtifactSignedInLinkOpened?: (opened: ArtifactSignedInLinkOpenedV1) => void | Promise<void>;
  authorizationHeaders?: (context: ActionExecutorContext, effectActionId: string) => ArtifactRequestAuthorizationHeaders;
}>) {
  const readUpload = async (context: ActionExecutorContext, input: Readonly<{ uploadPath: string; mime?: string; header: Readonly<Record<string, unknown>> }>, signal?: AbortSignal) => {
    const caller = await params.resolvePublishCaller(context);
    if (!caller) throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
    const { bytes } = await readArtifactWorkspaceFile({ caller, path: input.uploadPath, signal });
    return { binary: { bytes, mime: input.mime ?? (isArtifactHtmlHeaderV1(input.header)
      ? typeof input.header.mime === 'string' ? input.header.mime : 'text/html' : 'application/octet-stream') } };
  };
  return async (args: ArtifactHostActionInvocationV1 & Readonly<{ context: ActionExecutorContext; signal?: AbortSignal }>): Promise<unknown> => {
    const signal = args.signal ?? args.context.signal;
    const savedBy = artifactSavedByFromActionContextV1(args.context);
    const resolveAuthorization = args.actionId === 'doc.edit.accept' || args.actionId === 'doc.edit.decline'
      || args.context.externalActionCredential || args.context.externalActionExecutionAuthorization
      ? params.authorizationHeaders : undefined;
    signal?.throwIfAborted();
    try {
      if ((args.context.externalActionCredential || args.context.externalActionExecutionAuthorization) && !resolveAuthorization) {
        return { ok: false, errorCode: 'execution_not_authorized', error: 'execution_not_authorized' };
      }
      switch (args.actionId) {
        case 'doc.edit.accept':
          return await params.store.decideDocEditProposal({ actionId: args.actionId, input: DocEditAcceptHostInputV1Schema.parse(args.input), signal,
            ...(resolveAuthorization ? { authorizationHeaders: async request => resolveAuthorization(args.context,
              request.method === 'GET' ? 'artifact.get' : args.actionId)(request) } : {}) });
        case 'doc.edit.decline':
          return await params.store.decideDocEditProposal({ actionId: args.actionId, input: DocEditDeclineInputV1Schema.parse(args.input), signal,
            ...(resolveAuthorization ? { authorizationHeaders: resolveAuthorization(args.context, args.actionId) } : {}) });
        case 'artifact.public_link.join':
          if (!params.consumeArtifactSignedInLinkSecret || !params.onArtifactSignedInLinkOpened)
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return await params.store.joinSignedInLink({ input: args.input, signal }, {
            consumeSecret: params.consumeArtifactSignedInLinkSecret, onOpened: params.onArtifactSignedInLinkOpened });
        case 'artifact.public_link.create':
        case 'artifact.public_link.list':
        case 'artifact.public_link.revoke':
        case 'artifact.public_link.audit':
          return await params.store.publicLinks({ actionId: args.actionId, input: args.input, signal }, params.onPublicLinkIssued);
        case 'artifact.create': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          if ('uploadPath' in input) {
            return await params.store.create({ artifactId: input.artifactId, header: input.header,
              ...await readUpload(args.context, input, signal), savedBy, ...(signal ? { signal } : {}) });
          }
          return await params.store.create({ ...input, savedBy, ...(signal ? { signal } : {}) });
        }
        case 'artifact.get': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const artifact = await params.store.read(input.artifactId, { signal, includeSharedAudience: false,
            ...('readOnly' in args && args.readOnly ? { prepareRecipients: false } : {}),
            ...(resolveAuthorization ? { authorizationHeaders: resolveAuthorization(args.context, args.actionId) } : {}) });
          return { artifact };
        }
        case 'artifact.export': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          // Portable save/share belongs to the connected answering client, selected by the catalog.
          if ('portable' in input) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:artifact.export' };
          const caller = await params.resolvePublishCaller(args.context);
          if (!caller?.sessionId) throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
          const artifact = await params.store.read(input.artifactId, { signal, includeSharedAudience: false });
          if (!artifact) throw Object.assign(new Error('not_found'), { code: 'not_found' });
          if (!getArtifactKindPolicyV1(artifact.header.kind).browserListed) {
            throw Object.assign(new Error('artifact_kind_internal'), { code: 'artifact_kind_internal' });
          }
          if (!artifact.body || typeof artifact.body === 'string') {
            throw Object.assign(new Error('artifact_not_binary'), { code: 'artifact_not_binary' });
          }
          const bytes = await params.store.readBinary({ artifactId: input.artifactId, body: artifact.body, signal });
          return { artifactId: input.artifactId, ...await writeArtifactWorkspaceFile({ caller,
            path: input.path, overwrite: input.overwrite, bytes, sha256: artifact.body.sha256, signal }) };
        }
        case 'artifact.list': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const page = await params.store.list({ ...input, sort: input.sort ?? 'updated_desc', ...(signal ? { signal } : {}) });
          const items = page.items.map(projectArtifactHeaderV1);
          return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
        }
        case 'artifact.update': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const content = 'uploadPath' in input ? await readUpload(args.context, input, signal) : { body: input.body };
          const result = await params.store.update({ artifactId: input.artifactId, header: input.header,
            expectedRevision: input.expectedRevision, ...content, savedBy, ...(signal ? { signal } : {}) });
          return result.ok ? { artifactId: input.artifactId, revision: result.revision } : result;
        }
        case 'artifact.delete': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          await params.beforeDelete({ artifactId: input.artifactId, ...(signal ? { signal } : {}) });
          const result = await params.store.delete(input.artifactId, { expectedRevision: input.expectedRevision, ...(signal ? { signal } : {}) });
          return result.ok ? { artifactId: input.artifactId, deleted: true } : result;
        }
        case 'artifact.publish_from_file': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const caller = await params.resolvePublishCaller(args.context, input.workspace);
          if (!caller && input.workspace && params.forwardWorkspacePublication)
            return await params.forwardWorkspacePublication({ ...input, workspace: input.workspace }, args.context, signal);
          if (!caller) return { ok: false, errorCode: 'artifact_source_unavailable', error: 'artifact_source_unavailable' };
          return await publishArtifactFromWorkspaceFile({ store: params.store, caller, input, savedBy, ...(signal ? { signal } : {}) });
        }
        case 'artifact.revisions.list': {
          return await params.store.revisions.list(ArtifactActionInputSchemasV1[args.actionId].parse(args.input), signal);
        }
        case 'artifact.revisions.restore': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const result = await params.store.revisions.restore({ ...input, savedBy }, signal);
          return result.ok ? { artifactId: input.artifactId, revision: result.revision } : result;
        }
        case 'artifact.storage.usage': {
          ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          return await params.store.storageUsage(signal);
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      const code = error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
        ? String(Reflect.get(error, 'code')) : 'artifact_action_failed';
      return { ok: false, errorCode: code, error: code,
        ...(code === 'quota_exceeded' && error && typeof error === 'object' ? { details: Reflect.get(error, 'details') } : {}) };
    }
  };
}
