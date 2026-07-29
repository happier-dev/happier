import React from 'react';
import { useRouter } from 'expo-router';
import { useSessionListRenderablesById } from '@/sync/store/hooks';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { UsageBreakdownRow } from '@/sync/api/account/usageAnalytics';

/**
 * Shared session helpers for the usage dashboard's Pivot Sessions lens (E-1):
 * resolve a session breakdown row's LOCAL title from the store (never a raw id)
 * and deep-link to that session's usage route. Extracted from the composition so
 * `UsageAnalyticsDashboard` stays a thin band arranger under the <250-line gate.
 */
export function useUsageSessionResolvers(): {
    openSession: (sessionId: string) => void;
    resolveDisplayLabel: (dimension: UsageBreakdownRow['dimension'], label: string, key: string) => string;
} {
    const router = useRouter();
    const sessionListRenderablesById = useSessionListRenderablesById();

    const openSession = React.useCallback((targetSessionId: string) => {
        router.push({ pathname: '/session/[id]/usage', params: { id: targetSessionId } });
    }, [router]);

    const resolveDisplayLabel = React.useCallback((
        dimension: UsageBreakdownRow['dimension'],
        label: string,
        key: string,
    ): string => {
        if (dimension !== 'session') {
            return label;
        }
        const renderable = sessionListRenderablesById[key];
        return renderable ? getSessionName(renderable) : label;
    }, [sessionListRenderablesById]);

    return { openSession, resolveDisplayLabel };
}
