import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { SessionView } from '@/components/sessions/shell/SessionView';


export default React.memo(() => {
    const { id: sessionIdParam, jumpSeq: jumpSeqParam } = useLocalSearchParams<{ id?: string | string[]; jumpSeq?: string | string[] }>();
    const sessionId = typeof sessionIdParam === 'string' ? sessionIdParam : Array.isArray(sessionIdParam) ? (sessionIdParam[0] ?? '') : '';
    const jumpSeqRaw = typeof jumpSeqParam === 'string' ? jumpSeqParam : Array.isArray(jumpSeqParam) ? (jumpSeqParam[0] ?? '') : '';
    const jumpSeqNum = Number(jumpSeqRaw);
    const jumpToSeq = Number.isFinite(jumpSeqNum) && jumpSeqNum >= 0 ? Math.trunc(jumpSeqNum) : null;
    return (<SessionView id={sessionId} jumpToSeq={jumpToSeq} />);
});
