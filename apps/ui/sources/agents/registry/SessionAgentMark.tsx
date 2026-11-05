import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';

/**
 * A Session's Agent mark: the Agent's own mark when the catalog has one, the neutral glyph for a
 * Session without a recorded Agent or an Agent without a mark.
 */
export const SessionAgentMark = React.memo(function SessionAgentMark(props: Readonly<{
    agentId: string | null | undefined;
    size: number;
}>) {
    const { theme } = useUnistyles();
    return <AgentIcon agentId={props.agentId && hasAgentIconMark(props.agentId, theme) ? props.agentId : null} size={props.size} />;
});
