import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Platform, View } from 'react-native';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';

export default React.memo(() => {
    const params = useLocalSearchParams<{
        id?: string | string[];
        jumpSeq?: string | string[];
        right?: string | string[];
        details?: string | string[];
        path?: string | string[];
        sha?: string | string[];
    }>();
    const { id: sessionIdParam, jumpSeq: jumpSeqParam } = params;
    const sessionId = typeof sessionIdParam === 'string' ? sessionIdParam : Array.isArray(sessionIdParam) ? (sessionIdParam[0] ?? '') : '';
    const jumpSeqRaw = typeof jumpSeqParam === 'string'
        ? jumpSeqParam
        : Array.isArray(jumpSeqParam)
            ? (jumpSeqParam[0] ?? null)
            : null;
    const jumpSeqTrimmed = typeof jumpSeqRaw === 'string' ? jumpSeqRaw.trim() : '';
    const jumpSeqNum = jumpSeqTrimmed.length > 0 ? Number(jumpSeqTrimmed) : NaN;
    const jumpToSeq = Number.isFinite(jumpSeqNum) && jumpSeqNum >= 0 ? Math.trunc(jumpSeqNum) : null;
    const paneUrlState = React.useMemo(() => parseSessionPaneUrlState(params as any), [params]);

    const shouldDeferMount = Platform.OS !== 'web';
    const [mounted, setMounted] = React.useState(!shouldDeferMount);
    React.useEffect(() => {
        if (!shouldDeferMount) return;
        setMounted(false);
        return runAfterInteractionsWithFallback(() => setMounted(true));
    }, [sessionId, shouldDeferMount]);

    if (!mounted) {
        return <View style={{ flex: 1 }} />;
    }

    return (<SessionView id={sessionId} jumpToSeq={jumpToSeq} paneUrlState={paneUrlState ?? undefined} />);
});
