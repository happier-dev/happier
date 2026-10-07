import {
  ArtifactAccessActionInputSchemasV1,
  ArtifactAccessActionOutputSchemasV1,
  type ArtifactAccessActionIdV1,
  type ArtifactAccessGrantsListInputV1,
  type ArtifactAccessGrantSetInputV1,
  type ArtifactAccessGrantRemoveInputV1,
  type ArtifactAccessGrantsListResponseV1,
  type ArtifactAccessGrantMutationResponseV1,
} from '../../artifacts/artifactAccessV1.js';
import { getArtifactUseTargetV1, type ArtifactSharingResourceV1 } from '../../artifacts/artifactSharingV1.js';

export type ArtifactAccessActionTransportV1 = Readonly<{
  list: (input: ArtifactAccessGrantsListInputV1, signal?: AbortSignal) => Promise<ArtifactAccessGrantsListResponseV1>;
  set: (input: ArtifactAccessGrantSetInputV1, signal?: AbortSignal) => Promise<ArtifactAccessGrantMutationResponseV1>;
  remove: (input: ArtifactAccessGrantRemoveInputV1, signal?: AbortSignal) => Promise<ArtifactAccessGrantMutationResponseV1>;
}>;

/** The kind owner validates private content; the authenticated storage owner rechecks access. */
export function createArtifactAccessActionsV1(params: Readonly<{
  read: (artifactId: string, options?: Readonly<{ signal?: AbortSignal }>) => Promise<ArtifactSharingResourceV1 | null>;
  transport: ArtifactAccessActionTransportV1;
}>) {
  return async (args: Readonly<{ actionId: ArtifactAccessActionIdV1; input: unknown; signal?: AbortSignal }>) => {
    args.signal?.throwIfAborted();
    const input = ArtifactAccessActionInputSchemasV1[args.actionId].parse(args.input);
    const resource = await params.read(input.artifactId, args.signal ? { signal: args.signal } : undefined);
    args.signal?.throwIfAborted();
    if (!resource) throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
    // Kind admission prevents new grants, not inspection or revocation of retained access.
    if (args.actionId === 'artifact.access.grants.set' && !getArtifactUseTargetV1(resource).canShare) {
      throw Object.assign(new Error('artifact_kind_not_shareable'), { code: 'artifact_kind_not_shareable' });
    }
    if (!resource.access) throw Object.assign(new Error('artifact_access_unavailable'), { code: 'artifact_access_unavailable' });
    if (args.actionId !== 'artifact.access.grants.list' && resource.access !== 'owner' && resource.access !== 'admin') {
      throw Object.assign(new Error('artifact_access_forbidden'), { code: 'artifact_access_forbidden' });
    }
    let result: ArtifactAccessGrantsListResponseV1 | ArtifactAccessGrantMutationResponseV1;
    switch (args.actionId) {
      case 'artifact.access.grants.list': result = await params.transport.list(input, args.signal); break;
      case 'artifact.access.grants.set': result = await params.transport.set(ArtifactAccessActionInputSchemasV1[args.actionId].parse(input), args.signal); break;
      case 'artifact.access.grants.remove': result = await params.transport.remove(ArtifactAccessActionInputSchemasV1[args.actionId].parse(input), args.signal); break;
    }
    args.signal?.throwIfAborted();
    return ArtifactAccessActionOutputSchemasV1[args.actionId].parse(result);
  };
}
