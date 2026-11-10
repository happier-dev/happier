import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useSessionAgentCatalogIdentity } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * Session-chrome adapter onto the canonical machine-scoped Agent catalog. A Session whose Agent is not
 * known yet (not loaded, or no Agent recorded) has no identity to draw: it takes the neutral Session
 * glyph rather than a monogram of the catalog's "Unknown Backend" placeholder.
 */
export function SessionAgentCatalogIdentityIcon(props: Readonly<{
    agentId: string;
    machineId: string | null;
    serverId: string | null;
    color?: string;
    size?: number;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { entry, current } = useSessionAgentCatalogIdentity({
        agentId: props.agentId,
        machineId: props.machineId,
        serverId: props.serverId,
    });

    if (props.agentId.trim().length === 0) {
        return <Icon name="chat-circle" size={props.size ?? 29} color={props.color ?? theme.colors.text.secondary} testID={props.testID} />;
    }

    return (
        <AgentCatalogIdentityIcon
            entry={entry}
            machineId={props.machineId}
            serverId={props.serverId}
            current={current}
            color={props.color}
            size={props.size}
            testID={props.testID}
        />
    );
}
