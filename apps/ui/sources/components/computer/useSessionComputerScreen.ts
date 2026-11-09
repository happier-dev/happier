import * as React from 'react';
import { useBrowserSessionAgentIdentity } from '@/components/browser/copresence/BrowserShellPresence';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { useComputerScreen } from './useComputerScreen';

/** The Session presentation supplies its agent identity to the shared Computer owner. */
export function useSessionComputerScreen(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    machineId: string;
    enabled?: boolean;
}>) {
    const accountLifetime = useSessionViewerSourceAccountLifetime();
    const serverId = props.serverId ?? accountLifetime?.scope.serverId ?? null;
    const identity = useBrowserSessionAgentIdentity({ sessionId: props.sessionId, serverId });
    const scope = React.useMemo(() => ({ sessionId: props.sessionId, machineId: props.machineId, serverId }),
        [props.machineId, props.sessionId, serverId]);
    // An agent that does not resolve is no agent to name: the Computer owner then says its agentless sentences.
    const agent = React.useMemo(() => identity.agentless ? undefined : { agentId: identity.agentId, name: identity.name },
        [identity.agentId, identity.agentless, identity.name]);
    return useComputerScreen({ scope, accountLifetime, agent, refreshKey: identity.turnActive, enabled: props.enabled });
}
