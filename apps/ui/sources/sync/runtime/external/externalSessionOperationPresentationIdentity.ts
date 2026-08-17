import {
    projectExternalSessionOperationSharedPresentationV1,
    type ExternalSessionOperationProgressV1,
    type ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

export function createExternalSessionOperationPresentationIdentity(
    presentation: ExternalSessionOperationSharedPresentationV1,
): string {
    return JSON.stringify([
        presentation.v,
        presentation.operationId,
        presentation.revision,
        presentation.kind,
        presentation.status,
        presentation.phase,
    ]);
}

export function matchesExternalSessionOperationPresentation(
    progress: ExternalSessionOperationProgressV1,
    presentation: ExternalSessionOperationSharedPresentationV1,
): boolean {
    return createExternalSessionOperationPresentationIdentity(
        projectExternalSessionOperationSharedPresentationV1(progress),
    ) === createExternalSessionOperationPresentationIdentity(presentation);
}
