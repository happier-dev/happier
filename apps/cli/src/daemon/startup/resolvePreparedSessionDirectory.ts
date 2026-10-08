import type { SessionOwnerMetadataV1 } from '@happier-dev/protocol';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

export function resolvePreparedSessionDirectory(input: Readonly<{
    options: Pick<SpawnSessionOptions, 'directory' | 'directoryKind' | 'sessionCreationTag' | 'freshSessionCreation' | 'attachMetadataIdentityPolicy'>;
    normalizedExistingSessionId: string;
    ownerMetadata: SessionOwnerMetadataV1 | null;
    existingSessionWorkspacePath: string | null;
}>): Pick<SpawnSessionOptions, 'directory' | 'directoryKind' | 'sessionCreationTag'> {
    const trustedManagedCreation = input.options.freshSessionCreation === true
        && input.options.directoryKind === 'managed';
    const replacementRuntimeIdentity = input.options.attachMetadataIdentityPolicy === 'replace_with_runtime_identity';
    const directoryKind = input.normalizedExistingSessionId && !trustedManagedCreation && !replacementRuntimeIdentity
        ? readSessionDirectoryKind(input.ownerMetadata?.workspace)
        : input.options.directoryKind ?? 'path';
    const sessionCreationTag = input.normalizedExistingSessionId && !trustedManagedCreation
        ? input.ownerMetadata?.system?.sessionCreationCorrespondenceV1?.sessionCreationTag
        : input.options.sessionCreationTag;
    return {
        directory: replacementRuntimeIdentity
            ? input.options.directory
            : input.existingSessionWorkspacePath ?? input.options.directory,
        directoryKind,
        ...(sessionCreationTag ? { sessionCreationTag } : {}),
    };
}
