import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import { getAgentPickerIconScale } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { useSetting } from '@/sync/domains/state/storage';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionAvatarId } from '@/utils/sessions/sessionUtils';

export type SessionListIdentityDisplay = 'avatar' | 'agentLogo' | 'none';

export function normalizeSessionListIdentityDisplay(value: unknown): SessionListIdentityDisplay {
    return value === 'agentLogo' || value === 'none' ? value : 'avatar';
}

/** The single reader/normalizer for the person's Session-list identity preference. */
export function useSessionListIdentityDisplay(): SessionListIdentityDisplay {
    return normalizeSessionListIdentityDisplay(useSetting('sessionListIdentityDisplay'));
}

/** Canonical visual identity used anywhere a session is presented as a list row. */
export const SessionListIdentity = React.memo(function SessionListIdentity(props: Readonly<{
    session: Session | SessionListRenderableSession;
    display: SessionListIdentityDisplay;
    avatarSize: number;
    agentLogoSize: number;
    monochrome?: boolean;
    color?: string;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    if (props.display === 'none') return null;
    const agentId = resolveAgentIdFromSessionMetadata(props.session.metadata);
    if (props.display === 'agentLogo') {
        const color = props.monochrome === true ? theme.colors.text.tertiary : props.color;
        return (
            <AgentIcon
                agentId={agentId}
                size={props.agentLogoSize}
                // A logo is already a single tint, so the avatar's greyscale has no effect here:
                // a stopped session takes the dimmer ink instead.
                color={color}
                style={{ transform: [{ scale: agentId ? getAgentPickerIconScale(agentId) : 1 }] }}
                testID={props.testID ?? `session-list-agent-logo-${props.session.id}`}
            />
        );
    }
    return (
        <Avatar
            id={getSessionAvatarId(props.session)}
            size={props.avatarSize}
            monochrome={props.monochrome}
            flavor={agentId}
            hasUnreadMessages={false}
        />
    );
});
