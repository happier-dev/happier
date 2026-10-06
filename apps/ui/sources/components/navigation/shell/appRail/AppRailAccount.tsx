import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import {
    ConnectionStatusControl,
    type ConnectionStatusTriggerState,
} from '@/components/navigation/ConnectionStatusControl';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { DeferredAnchoredTooltip } from '@/components/ui/overlays/DeferredAnchoredTooltip';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { resolveViewerAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { getAvatarUrl, getDisplayName } from '@/sync/domains/profiles/profile';
import { useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { APP_RAIL_AVATAR_SIZE_PX, APP_RAIL_ITEM_SIZE_PX } from './appRailMetrics';

type AccountIdentity =
    | Readonly<{ kind: 'signedIn'; name: string; profileId: string; imageUrl: string | null; thumbhash?: string }>
    | Readonly<{ kind: 'notLinked'; title: string }>;

/**
 * Who is here, at the foot of the rail: the person's avatar with their Home's state as a dot. It is the
 * trigger of the one Home/account popover (`ConnectionStatusControl`, owned by the Homes program),
 * which opens beside the rail. Only when there is no person to show and this device holds no sign-in
 * to the Home's own sign-in service (`state.accountService`, the popover's owner) does the mark stand
 * for "Link to {service}" instead.
 */
export const AppRailAccount = React.memo(function AppRailAccount(props: Readonly<{
    renderTrigger?: (state: ConnectionStatusTriggerState) => React.ReactNode;
}>) {
    const renderTrigger = React.useCallback(
        (state: ConnectionStatusTriggerState) => <AppRailAccountTrigger state={state} />,
        [],
    );

    return (
        <ConnectionStatusControl variant="sidebar" popoverPlacement="right" renderTrigger={props.renderTrigger ?? renderTrigger} />
    );
});

function resolveAccountIdentity(
    profile: ReturnType<typeof useProfile>,
    accountService: ConnectionStatusTriggerState['accountService'],
): AccountIdentity {
    const displayName = getDisplayName(profile);
    if (!displayName && accountService.kind === 'service' && accountService.signedIn === false) {
        return {
            kind: 'notLinked',
            title: accountService.serviceName
                ? t('sidebarFooter.linkToService', { service: accountService.serviceName })
                : t('sidebarFooter.addHomeOrSignIn'),
        };
    }
    // Signed in, the Home's own service, no service, or not read yet: the person stays.
    return {
        kind: 'signedIn',
        name: resolveViewerAccountDisplayName(displayName),
        profileId: profile.id,
        imageUrl: getAvatarUrl(profile),
        thumbhash: profile.avatar?.thumbhash,
    };
}

const AppRailAccountTrigger = React.memo(function AppRailAccountTrigger(props: Readonly<{
    state: ConnectionStatusTriggerState;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { state } = props;
    const profile = useProfile();
    const identity = React.useMemo(
        () => resolveAccountIdentity(profile, state.accountService),
        [profile, state.accountService],
    );
    const anchorRef = React.useRef<View>(null);
    const [hovered, setHovered] = React.useState(false);
    const title = identity.kind === 'signedIn' ? identity.name : identity.title;
    const tooltip = `${title} · ${state.homeLabel}`;
    return (
        <View
            ref={anchorRef}
            collapsable={false}
            {...(Platform.OS === 'web' ? { onPointerEnter: () => setHovered(true), onPointerLeave: () => setHovered(false) } : null)}
        >
            <HappierPressable
                testID={identity.kind === 'signedIn' ? 'app-rail-account' : 'app-rail-account-link-entry'}
                accessibilityLabel={`${title}, ${state.accessibilityLabel}`}
                expanded={state.open}
                hasPopup="dialog"
                onPress={state.activate}
                style={(pressState) => [
                    styles.trigger,
                    pressState.hovered || state.open ? styles.triggerActive : null,
                    pressState.pressed ? styles.triggerPressed : null,
                    focusRingStyle({ focused: pressState.focused, color: theme.colors.border.focus }),
                ]}
            >
                {identity.kind === 'signedIn' ? (
                    <Avatar
                        id={identity.profileId}
                        size={APP_RAIL_AVATAR_SIZE_PX}
                        imageUrl={identity.imageUrl}
                        thumbhash={identity.thumbhash}
                    />
                ) : (
                    <Icon name="user-circle" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />
                )}
                {/* The Home's state on the avatar's corner; a Home that needs the person shows a warning mark. */}
                <View style={styles.status}>
                    {state.needsAttention ? (
                        <Icon name="warning" size={10} color={state.statusColor} />
                    ) : (
                        <StatusDot color={state.statusColor} isPulsing={state.connecting} size={8} />
                    )}
                </View>
            </HappierPressable>
            {Platform.OS === 'web' && hovered && !state.open ? (
                <DeferredAnchoredTooltip
                    activationKey={`${hovered}`}
                    anchorRef={anchorRef}
                    placement="right"
                    label={tooltip}
                    testID="app-rail-account-tooltip"
                />
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    trigger: {
        width: APP_RAIL_ITEM_SIZE_PX,
        height: APP_RAIL_ITEM_SIZE_PX,
        borderRadius: APP_RAIL_ITEM_SIZE_PX / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    triggerActive: {
        backgroundColor: theme.colors.surface.selected,
    },
    triggerPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    status: {
        position: 'absolute',
        right: 3,
        bottom: 3,
        padding: 1.5,
        borderRadius: 6,
        backgroundColor: theme.colors.background.canvas,
    },
}));
