import { randomUUID } from '@/platform/randomUUID';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveNewSessionDraftRouteIdentity(params: Readonly<{
    routeDraftId: string | string[] | undefined;
    createDraftId?: () => string;
}>): Readonly<{
    draftId: string;
    shouldWriteRouteParam: boolean;
}> {
    const routeDraftId = typeof params.routeDraftId === 'string'
        ? params.routeDraftId.trim()
        : '';
    if (UUID_PATTERN.test(routeDraftId)) {
        return { draftId: routeDraftId, shouldWriteRouteParam: false };
    }
    return {
        draftId: (params.createDraftId ?? randomUUID)(),
        shouldWriteRouteParam: true,
    };
}
