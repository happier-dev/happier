import { ExternalSessionOperationSharedPresentationV1Schema } from '@happier-dev/protocol/sessions/external/operationV1';
import type { SessionMetadata } from '@happier-dev/protocol/sessions/control/contract';

export function readExternalSessionOperationPresentationFromMetadata(
    metadata: SessionMetadata | null | undefined,
) {
    if (!metadata) return null;
    const parsed = ExternalSessionOperationSharedPresentationV1Schema.safeParse(
        metadata.externalSessionOperationPresentationV1,
    );
    return parsed.success ? parsed.data : null;
}
