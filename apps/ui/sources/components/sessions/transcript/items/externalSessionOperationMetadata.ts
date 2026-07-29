import {
    ExternalSessionOperationSharedPresentationV1Schema,
    type SessionMetadata,
} from '@happier-dev/protocol';

export function readExternalSessionOperationPresentationFromMetadata(
    metadata: SessionMetadata | null | undefined,
) {
    if (!metadata) return null;
    const parsed = ExternalSessionOperationSharedPresentationV1Schema.safeParse(
        metadata.externalSessionOperationPresentationV1,
    );
    return parsed.success ? parsed.data : null;
}
