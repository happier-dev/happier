import * as React from 'react';
import { SidePaneBodyProvider, usePaneContentInsetPx } from '@/components/ui/lists/listPresentation';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { ITEM_SUBTITLE_TEXT_METRICS, ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { SessionAccessEditorModel, SessionAccessPrincipalPresentation } from '@/components/sessions/access/sessionAccessEditorTypes';

const MARK_PX = 28;

export type SessionCollaborationAccessCardModel = Readonly<{
    state: 'loading' | 'error' | 'ready';
    title: string;
    /** Who has access (`Have access`), or the state line while it is read. */
    subtitle: string;
    publicLinkOn: boolean;
    /** Up to three identity marks for the people and teams with access. */
    principals: readonly SessionAccessPrincipalPresentation[];
    /** The Session is shared with nobody yet and the viewer can change that. */
    notShared: boolean;
}>;

function formatNames(principals: readonly SessionAccessPrincipalPresentation[]): string {
    const [first, second, third] = principals.map((principal) => principal.displayName);
    if (!first) return '';
    if (!second) return first;
    if (!third) return t('session.collaboration.pane.namesTwo', { first, second });
    if (principals.length === 3) return t('session.collaboration.pane.namesThree', { first, second, third });
    return t('session.collaboration.pane.namesMore', { first, second, count: principals.length - 2 });
}

/**
 * What the access card at the pane's foot says (lab `collab` C1): who the Session is shared with,
 * that they have access, and whether a public link is on — one line each, from the one access
 * model and the one publication controller the Share panel also renders.
 */
export function projectSessionCollaborationAccessCard(input: Readonly<{
    model: SessionAccessEditorModel | null;
    publicLinkOn: boolean;
}>): SessionCollaborationAccessCardModel {
    const { model, publicLinkOn } = input;
    if (!model) {
        // A Home without named access: the card is about the public link only.
        return { state: 'ready', title: t('session.collaboration.pane.onlyYou'), subtitle: '', publicLinkOn, principals: [], notShared: false };
    }
    if (!model.content.hasLastAcknowledgedSnapshot) {
        const failed = model.content.phase === 'error';
        return {
            state: failed ? 'error' : 'loading',
            title: t('session.access.title'),
            subtitle: failed ? t('session.collaboration.pane.accessError') : t('session.collaboration.pane.accessLoading'),
            publicLinkOn,
            principals: [],
            notShared: false,
        };
    }
    const grants = model.grants.map((row) => row.principal);
    if (grants.length > 0) {
        return {
            state: 'ready',
            title: formatNames(grants),
            subtitle: grants.length === 1 ? t('session.collaboration.pane.hasAccess') : t('session.collaboration.pane.haveAccess'),
            publicLinkOn,
            principals: grants.slice(0, 3),
            notShared: false,
        };
    }
    // A collaborator without the roster sees their own admitted access, never the private grants.
    if (model.viewerAccess) {
        return {
            state: 'ready',
            title: model.summary.label,
            subtitle: model.viewerAccess.levelLabel,
            publicLinkOn,
            principals: [],
            notShared: false,
        };
    }
    return {
        state: 'ready',
        title: t('session.collaboration.pane.onlyYou'),
        subtitle: t('session.collaboration.pane.notShared'),
        publicLinkOn,
        principals: [],
        notShared: model.accessMode === 'editable',
    };
}

const styles = StyleSheet.create((theme) => ({
    block: {
        marginTop: theme.space.s12,
        marginBottom: theme.space.s12,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        // An in-flow card on the pane: the card fill and flat edge every grouped sheet uses, not a
        // control's fill step (which read as a dark grey block) and no shadow.
        borderColor: theme.colors.edge.surface,
        backgroundColor: theme.colors.edge.cardFill,
        overflow: 'hidden',
    },
    divider: { height: StyleSheet.hairlineWidth, marginLeft: theme.space.s12, backgroundColor: theme.colors.border.default },
    mark: {
        width: MARK_PX,
        height: MARK_PX,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        ...Typography.default('semiBold'),
        ...ITEM_TITLE_TEXT_METRICS.compact,
        color: theme.colors.text.primary,
    },
    subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minWidth: 0 },
    subtitle: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.compact,
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    separator: { color: theme.colors.text.tertiary },
}));

/**
 * The block pinned at the Collaboration pane's foot (user ruling 2026-09-29): who has access, and
 * beneath it in the same block the Responsible row. The access part is the most intentful thing on
 * the tab and where Share grows from (lab `collab` SH): pressing it grows the block in place into the
 * Share panel.
 */
export const SessionCollaborationAccessCard = React.forwardRef<React.ElementRef<typeof Pressable>, Readonly<{
    card: SessionCollaborationAccessCardModel;
    expanded: boolean;
    onPress: () => void;
    /** The rest of the block (the Responsible row), under a hairline. */
    children?: React.ReactNode;
}>>(function SessionCollaborationAccessCard(props, ref) {
    const { theme } = useUnistyles();
    // The card stands on the pane's text edge; its rows keep the card's own inset.
    const contentInsetPx = usePaneContentInsetPx();
    const { card } = props;
    const subtitleParts = [card.subtitle, card.publicLinkOn ? t('session.collaboration.pane.publicLinkOn') : ''].filter(Boolean);
    return (
        <View style={[styles.block, { marginHorizontal: contentInsetPx }]}>
            <SidePaneBodyProvider active={false}>
            <Item
                pressableRef={ref}
                testID="session-collaboration-access-card"
                accessibilityRole="button"
                accessibilityExpanded={props.expanded}
                accessibilityLabel={`${t('session.collaboration.pane.shareTitle')}: ${[card.title, ...subtitleParts].join('. ')}`}
                onPress={props.onPress}
                density="compact"
                showDivider={false}
                showChevron={false}
                leftElement={card.principals.length > 0 ? <AvatarStack size={MARK_PX - 4} ringColor={theme.colors.edge.cardFill} entries={card.principals.map((principal) => ({
                    key: principal.key,
                    avatar: principal.ref.kind === 'account',
                    content: principal.ref.kind === 'account'
                        ? <Avatar id={principal.avatar?.id ?? principal.key} size={MARK_PX - 4} imageUrl={principal.avatar?.imageUrl ?? null} />
                        : <Icon name="users" size={14} color={theme.colors.text.secondary} />,
                }))} /> : undefined}
                // Without faces the mark takes the row icon slot, so "Only you" and Responsible below it
                // start their words on one edge.
                icon={card.principals.length > 0 ? undefined : <Icon name={card.publicLinkOn ? 'link' : 'users'} size={18} color={theme.colors.text.secondary} />}
                title={<Text testID="session-collaboration-access-card-title" style={styles.title} numberOfLines={1}>{card.title}</Text>}
                subtitle={subtitleParts.length > 0 ? (
                        <View style={styles.subtitleRow}>
                            {card.subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{card.subtitle}</Text> : null}
                            {card.subtitle && card.publicLinkOn ? <Text style={[styles.subtitle, styles.separator]}>·</Text> : null}
                            {card.publicLinkOn ? <Icon name="link" size={12} color={theme.colors.text.secondary} /> : null}
                            {card.publicLinkOn ? <Text testID="session-collaboration-access-card-link" style={styles.subtitle} numberOfLines={1}>{t('session.collaboration.pane.publicLinkOn')}</Text> : null}
                        </View>
                    ) : undefined}
                rightElement={<Icon name="caret-up" size={14} color={theme.colors.text.tertiary} />}
            />
            {props.children ? <View style={styles.divider} /> : null}
            {props.children}
            </SidePaneBodyProvider>
        </View>
    );
});
