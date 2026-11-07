import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ACCOUNT_SETTING_DEFINITIONS, SessionListIdentityDisplaySchema, type SessionListIdentityDisplay } from '@happier-dev/protocol/account/settings/accountSettings';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { readSessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import type { BotActivity } from '@/components/sessions/bots/botActivity';
import { useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPresentationAgentId, readSessionRowPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readSessionListPresentationDisplay, readSessionListPresentationOwnerMetadataField,
    type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { getSessionAvatarId } from '@/utils/sessions/sessionUtils';

import type { WorkspaceFavicon } from '@/sync/ops/workspaceFavicon';

import { SessionAgentCatalogIdentityIcon } from '../presentation/SessionAgentCatalogIdentityIcon';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { resolveSessionListProjectMarkBadgeGeometry, SessionListMarkBadge, SessionListProjectMark } from './SessionListProjectMark';

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
    /** The Bots roster names who is there: a Bot's identity stays in colour while it sleeps; its state is the subtitle. */
    roster?: boolean;
    /** The row's derived coordinator fact (`deriveSessionCoordinatorV1`); only `true` draws the mark. */
    coordinator?: boolean;
    /** A Bot row's `botActivity`, when the surface already decided it; the face shows it in its mouth. */
    botActivity?: BotActivity;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    if (props.display === 'none') return null;
    const source = props.presentationSource;
    const display = source ? readSessionListPresentationDisplay(source) : props.session;
    const notLive = !props.roster && ((source?.lifecycle.active ?? props.session.active) !== true || !props.connected);
    const { agentId, machineId } = readSessionListIdentityFacts(props.session, source);

    // The lab's sub-badge (P3·L `lGlyph`): a small coordinator glyph cut out of the mark's bottom-right corner.
    // A Project-led mark already holds that corner with its Agent badge, so the coordinator takes the top-right.
    const withCoordinatorMark = (mark: React.ReactElement, size: number, corner: 'bottomRight' | 'topRight', badgeScale?: number) => (
        props.coordinator === true ? (
            <SessionListMarkBadge size={size} corner={corner} badgeScale={badgeScale} badge={
                <View
                    testID={props.testID ? `${props.testID}-coordinator-mark` : undefined}
                    accessibilityRole="image"
                    accessibilityLabel={t('sessionWork.list.coordinator')}
                >
                    <Icon name="tree-structure" size={resolveSessionListProjectMarkBadgeGeometry(size, badgeScale).badge} color={theme.colors.text.secondary} />
                </View>
            }>
                {mark}
            </SessionListMarkBadge>
        ) : mark
    );

    // A Bot is drawn by its face on every identity display (Living Bots lab), never by its Agent's glyph or its
    // Project: it keeps its colour on every surface (lab R6 shell); its state is the mouth and the status word, not grey.
    const botFace = readSessionBotFaceFacts(display, props.serverId, source);
    if (botFace) {
        const size = props.display === 'avatar' ? props.avatarSize : props.agentLogoSize;
        return withCoordinatorMark(
            <SessionBotFace facts={botFace} size={size} mood={props.botActivity} motion={props.roster ? true : 'interaction'} />,
            size, 'bottomRight', 0.4,
        );
    }

    if (props.display === 'avatar') {
        return withCoordinatorMark(
            <Avatar
                id={getSessionAvatarId(display, props.serverId)}
                size={props.avatarSize}
                monochrome={notLive}
                flavor={agentId}
                hasUnreadMessages={false}
            />,
            props.avatarSize, 'bottomRight', 0.4,
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
        return withCoordinatorMark(
            <SessionListProjectMark favicon={props.projectFavicon ?? null} size={props.agentLogoSize} badge={badge} testID={props.testID} />,
            props.agentLogoSize, 'topRight',
        );
    }

    return withCoordinatorMark(
        <SessionAgentCatalogIdentityIcon
            agentId={agentId ?? ''}
            machineId={machineId ?? null}
            serverId={props.serverId}
            // A logo is already a single tint, so the avatar's greyscale has no effect here:
            // a session that is not live takes the dimmer ink instead.
            color={notLive ? theme.colors.text.tertiary : props.color}
            size={props.agentLogoSize}
            testID={props.testID}
        />,
        props.agentLogoSize, 'bottomRight',
    );
});
