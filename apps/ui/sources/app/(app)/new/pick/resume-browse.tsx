import { Redirect, useLocalSearchParams } from 'expo-router';
import { normalizeOptionalParam } from '@/profileRouteParams';

type LegacyResumeBrowseParams = Readonly<{
    agentType?: string | string[];
    providerId?: string | string[];
    machineId?: string | string[];
    spawnServerId?: string | string[];
    serverId?: string | string[];
    dataId?: string | string[];
    draftId?: string | string[];
    currentResumeId?: string | string[];
    resumeSessionId?: string | string[];
}>;

function normalizeNonEmptyParam(value?: string | string[]): string | undefined {
    const normalized = normalizeOptionalParam(value);
    if (typeof normalized !== 'string') return undefined;
    const trimmed = normalized.trim();
    return trimmed || undefined;
}

function pickFirstString(...values: Array<string | string[] | undefined>): string | undefined {
    for (const value of values) {
        const normalized = normalizeNonEmptyParam(value);
        if (normalized) return normalized;
    }
    return undefined;
}

export default function LegacyResumeBrowseRoute() {
    const params = useLocalSearchParams<LegacyResumeBrowseParams>();

    const agentType = pickFirstString(params.agentType, params.providerId);
    const machineId = normalizeNonEmptyParam(params.machineId);
    const spawnServerId = pickFirstString(params.spawnServerId, params.serverId);
    const dataId = normalizeNonEmptyParam(params.dataId);
    const draftId = normalizeNonEmptyParam(params.draftId);
    const currentResumeId = pickFirstString(params.currentResumeId, params.resumeSessionId);

    return (
        <Redirect
            href={{
                pathname: '/new/pick/resume',
                params: {
                    ...(agentType ? { agentType } : {}),
                    ...(machineId ? { machineId } : {}),
                    ...(spawnServerId ? { spawnServerId } : {}),
                    ...(dataId ? { dataId } : {}),
                    ...(draftId ? { draftId } : {}),
                    ...(currentResumeId ? { currentResumeId } : {}),
                },
            }}
        />
    );
}
