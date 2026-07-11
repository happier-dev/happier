import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

function normalizeServerId(value: string | null | undefined): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

export function useLocalServicePublicPreviewFeatureEnabled(
    serverId: string | null | undefined,
): boolean {
    const normalizedServerId = normalizeServerId(serverId);
    const decision = useFeatureDecision(
        'localServices.publicPreview',
        normalizedServerId
            ? { scopeKind: 'spawn', serverId: normalizedServerId }
            : { scopeKind: 'runtime' },
    );

    return decision?.state === 'enabled';
}
