import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { SessionView } from '@/components/sessions/shell/SessionView';


export default React.memo(() => {
    const { id: sessionIdParam } = useLocalSearchParams<{ id?: string | string[] }>();
    const sessionId = typeof sessionIdParam === 'string' ? sessionIdParam : Array.isArray(sessionIdParam) ? (sessionIdParam[0] ?? '') : '';
    return (<SessionView id={sessionId} />);
});
