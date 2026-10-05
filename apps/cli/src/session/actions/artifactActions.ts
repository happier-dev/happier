import { ArtifactActionInputSchemasV1, isArtifactHtmlHeaderV1, type ActionExecutorContext, type ArtifactActionIdV1, type ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { publishArtifactFromWorkspaceFile, readArtifactWorkspaceFile } from './publishArtifactFromWorkspaceFile';

type ArtifactPublishCaller = Readonly<{ sessionId: string; machineId: string; directory: string; runId?: string }>;

/** Account content stays in the existing Artifact store; only the host resolves publication authority. */
export function createCliArtifactActions(params: Readonly<{
  store: ReturnType<typeof createAccountArtifactStore>;
  resolvePublishCaller: (context: ActionExecutorContext) => Promise<ArtifactPublishCaller | null>;
  onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>;
}>) {
  const readUpload = async (context: ActionExecutorContext, input: Readonly<{ uploadPath: string; mime?: string; header: Readonly<Record<string, unknown>> }>, signal?: AbortSignal) => {
    const caller = await params.resolvePublishCaller(context);
    if (!caller) throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
    const { bytes } = await readArtifactWorkspaceFile({ caller, path: input.uploadPath, signal });
    return { binary: { bytes, mime: input.mime ?? (isArtifactHtmlHeaderV1(input.header)
      ? typeof input.header.mime === 'string' ? input.header.mime : 'text/html' : 'application/octet-stream') } };
  };
  return async (args: Readonly<{ actionId: ArtifactActionIdV1; input: unknown; context: ActionExecutorContext; signal?: AbortSignal }>): Promise<unknown> => {
    const signal = args.signal ?? args.context.signal;
    signal?.throwIfAborted();
    try {
      switch (args.actionId) {
        case 'artifact.public_link.create':
        case 'artifact.public_link.list':
        case 'artifact.public_link.revoke':
        case 'artifact.public_link.audit':
          return await params.store.publicLinks({ actionId: args.actionId, input: args.input, signal }, params.onPublicLinkIssued);
        case 'artifact.create': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          if ('uploadPath' in input) {
            return await params.store.create({ artifactId: input.artifactId, header: input.header,
              ...await readUpload(args.context, input, signal), ...(signal ? { signal } : {}) });
          }
          return await params.store.create({ ...input, ...(signal ? { signal } : {}) });
        }
        case 'artifact.get': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const artifact = await params.store.read(input.artifactId, signal ? { signal } : undefined);
          return { artifact, ...(artifact ? await params.store.htmlPreview(artifact, signal) : {}) };
        }
        case 'artifact.list': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const page = await params.store.list({ ...input, sort: input.sort ?? 'updated_desc', ...(signal ? { signal } : {}) });
          return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
        }
        case 'artifact.update': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const content = 'uploadPath' in input ? await readUpload(args.context, input, signal) : { body: input.body };
          const result = await params.store.update({ artifactId: input.artifactId, header: input.header,
            expectedRevision: input.expectedRevision, ...content, ...(signal ? { signal } : {}) });
          return result.ok ? { artifactId: input.artifactId, revision: result.revision,
            ...(result.previewUrl ? { previewUrl: result.previewUrl } : {}),
            ...(result.previewError ? { previewError: result.previewError } : {}) } : result;
        }
        case 'artifact.delete': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const result = await params.store.delete(input.artifactId, { expectedRevision: input.expectedRevision, ...(signal ? { signal } : {}) });
          return result.ok ? { artifactId: input.artifactId, deleted: true } : result;
        }
        case 'artifact.publish_from_file': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const caller = await params.resolvePublishCaller(args.context);
          if (!caller) return { ok: false, errorCode: 'artifact_source_unavailable', error: 'artifact_source_unavailable' };
          return await publishArtifactFromWorkspaceFile({ store: params.store, caller, input, ...(signal ? { signal } : {}) });
        }
        case 'artifact.revisions.list': {
          return await params.store.revisions.list(ArtifactActionInputSchemasV1[args.actionId].parse(args.input), signal);
        }
        case 'artifact.revisions.restore': {
          const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
          const result = await params.store.revisions.restore(input, signal);
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
