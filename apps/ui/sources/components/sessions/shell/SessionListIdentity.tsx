import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { ACCOUNT_SETTING_DEFINITIONS, SessionListIdentityDisplaySchema, type SessionListIdentityDisplay } from '@happier-dev/protocol/account/settings/accountSettings';
import type { WorkspaceFavicon } from '@/sync/ops/workspaceFavicon';
import { resolveSessionListProjectMarkBadgeGeometry, SessionListProjectMark } from './SessionListProjectMark';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPresentationAgentId, readSessionRowPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readSessionListPresentationDisplay, readSessionListPresentationOwnerMetadataField, type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { getSessionAvatarId } from '@/utils/sessions/sessionUtils';

import { SessionAgentCatalogIdentityIcon } from '../presentation/SessionAgentCatalogIdentityIcon';

export type { SessionListIdentityDisplay } from '@happier-dev/protocol/account/settings/accountSettings';

export function normalizeSessionListIdentityDisplay(value: unknown): SessionListIdentityDisplay {
    const parsed = SessionListIdentityDisplaySchema.safeParse(value);
    return parsed.success ? parsed.data : ACCOUNT_SETTING_DEFINITIONS.sessionListIdentityDisplay.default;
}

/** The single reader/normalizer for the person's Session-list identity preference. */
export function useSessionListIdentityDisplay(): SessionListIdentityDisplay {
    return normalizeSessionListIdentityDisplay(useSetting('sessionListIdentityDisplay'));
}

/**
 * The Agent mark's inputs for a Session, the one reading every identity consumer shares (Session-list
 * rows here; the desktop overlay projects it into its payload because its window has no Session store).
 */
export function readSessionListIdentityFacts(
    session: Session | SessionListRenderableSession,
    presentationSource?: SessionListPresentationSource,
): Readonly<{ agentId: string | null; machineId: string | null }> {
    const display = presentationSource ? readSessionListPresentationDisplay(presentationSource) : session;
    const metadata = 'agentState' in session ? readSessionOwnerMetadataView(session) : session.metadata;
    const agentId = presentationSource ? readSessionPresentationAgentId(display) : readSessionRowPresentationAgentId(session);
    const machineId = presentationSource
        ? readSessionListPresentationOwnerMetadataField(presentationSource, 'machineId')
        : metadata?.machineId;
    return { agentId: agentId ?? null, machineId: typeof machineId === 'string' ? machineId : null };
}

/**
 * Canonical leading identity used by Session-list-shaped rows.
 * Consumers choose geometry, while avatar-vs-Agent-logo semantics stay here.
 */
export const SessionListIdentity = React.memo(function SessionListIdentity(props: Readonly<{
    session: Session | SessionListRenderableSession;
    presentationSource?: SessionListPresentationSource;
    /** A resolved row mark (`project`/`projectWithAgent` come from the list's row context). */
    display: SessionListIdentityDisplay | 'project' | 'projectWithAgent';
    /** The row Project's favicon, observed from the shared resource; null keeps the folder fallback. */
    projectFavicon?: WorkspaceFavicon | null;
    serverId: string | null;
    color: string;
    avatarSize: number;
    agentLogoSize: number;
    connected: boolean;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    if (props.display === 'none') return null;
    const source = props.presentationSource;
    const display = source ? readSessionListPresentationDisplay(source) : props.session;
    const notLive = (source?.lifecycle.active ?? props.session.active) !== true || !props.connected;
    const { agentId, machineId } = readSessionListIdentityFacts(props.session, source);

    if (props.display === 'avatar') {
        return (
            <Avatar
                id={getSessionAvatarId(display, props.serverId)}
                size={props.avatarSize}
                monochrome={notLive}
                flavor={agentId}
                hasUnreadMessages={false}
            />
        );
    }

    if (props.display === 'project' || props.display === 'projectWithAgent') {
        const badge = props.display === 'projectWithAgent' ? (
            <SessionAgentCatalogIdentityIcon
                agentId={agentId ?? ''}
                machineId={machineId ?? null}
                serverId={props.serverId}
                color={theme.colors.text.secondary}
                size={resolveSessionListProjectMarkBadgeGeometry(props.agentLogoSize).badge}
                testID={props.testID ? `${props.testID}-agent-badge` : undefined}
            />
        ) : null;
        return <SessionListProjectMark favicon={props.projectFavicon ?? null} size={props.agentLogoSize} badge={badge} testID={props.testID} />;
    }

    return (
        <SessionAgentCatalogIdentityIcon
            agentId={agentId ?? ''}
            machineId={machineId ?? null}
            serverId={props.serverId}
            // A logo is already a single tint, so the avatar's greyscale has no effect here:
            // a session that is not live takes the dimmer ink instead.
            color={notLive ? theme.colors.text.tertiary : props.color}
            size={props.agentLogoSize}
            testID={props.testID}
        />
    );
});
