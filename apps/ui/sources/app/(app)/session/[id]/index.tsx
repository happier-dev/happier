import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { getTempData } from '@/utils/sessions/tempDataStore';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { storage } from '@/sync/domains/state/storageStore';

export default function SessionRouteIndex() {
    const params = useLocalSearchParams<{
        id?: string | string[];
        jumpSeq?: string | string[];
        right?: string | string[];
        bottom?: string | string[];
        details?: string | string[];
        path?: string | string[];
        sha?: string | string[];
        recoveryDataId?: string | string[];
    }>();
    const { id: sessionIdParam, jumpSeq: jumpSeqParam, recoveryDataId: recoveryDataIdParam } = params;
    const sessionId = normalizeSessionId(sessionIdParam);
    const jumpSeqRaw = typeof jumpSeqParam === 'string'
        ? jumpSeqParam
        : Array.isArray(jumpSeqParam)
            ? (jumpSeqParam[0] ?? null)
            : null;
    const jumpSeqTrimmed = typeof jumpSeqRaw === 'string' ? jumpSeqRaw.trim() : '';
    const jumpSeqNum = jumpSeqTrimmed.length > 0 ? Number(jumpSeqTrimmed) : NaN;
    const jumpToSeq = Number.isFinite(jumpSeqNum) && jumpSeqNum >= 0 ? Math.trunc(jumpSeqNum) : null;
    const recoveryDataId = typeof recoveryDataIdParam === 'string'
        ? recoveryDataIdParam
        : Array.isArray(recoveryDataIdParam)
            ? (recoveryDataIdParam[0] ?? '')
            : '';
    const recoverableAttachmentDrafts = React.useMemo(() => {
        const trimmedRecoveryDataId = recoveryDataId.trim();
        if (!trimmedRecoveryDataId) {
            return null;
        }

        const data = getTempData<{ attachmentDrafts?: readonly AttachmentDraft[] | null }>(trimmedRecoveryDataId);
        return Array.isArray(data?.attachmentDrafts) ? data.attachmentDrafts : null;
    }, [recoveryDataId]);
    const paneUrlState = React.useMemo(() => parseSessionPaneUrlState(params as any), [params]);

    const [activeServerGeneration, setActiveServerGeneration] = React.useState(() => getActiveServerSnapshot().generation);
    React.useEffect(() => {
        return subscribeActiveServer((snapshot) => {
            setActiveServerGeneration(snapshot.generation);
        });
    }, []);

    const sessionHydrated = useHydrateSessionForRoute(
        sessionId,
        `SessionRoute.ensureSessionVisible gen=${activeServerGeneration}`,
    );
    const sessionCached = Boolean(storage.getState().sessions[sessionId] ?? null);

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
    }

    if (!sessionHydrated && !sessionCached) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator size="small" />
            </View>
        );
    }

    return (
        <SessionView
            id={sessionId}
            jumpToSeq={jumpToSeq}
            paneUrlState={paneUrlState ?? undefined}
            initialAttachmentDrafts={recoverableAttachmentDrafts}
        />
    );
}
