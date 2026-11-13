import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HomeAuthenticationFlow } from '@/components/account/auth/HomeAuthenticationFlow';
import { useExactSavedHomeAuthenticationCatalog } from '@/components/account/auth/useExactSavedHomeAuthenticationCatalog';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { HomeMark } from '@/components/homes/HomeMark';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { t } from '@/text';

import { PaneConfirmed, PaneHeader, PaneIdentityRow } from './journeyPaneKit';

/**
 * Path (c), second step (lab K1d): the Home answered and is saved on this device; the person signs
 * in with the methods that Home offers — read from that exact Home (`useExactSavedHomeAuthenticationCatalog`),
 * never from the Home in focus — through the Home sign-in owner (`HomeAuthenticationFlow`).
 */
export function HomeSignInPane(props: Readonly<{
    profile: ServerProfile;
    onBack: () => void;
    onDone: () => void;
    /** `host`: the hosting page's back control returns to the previous pane, so the pane draws none. */
    backControl?: 'pane' | 'host';
}>) {
    const { theme } = useUnistyles();
    const { profile } = props;
    const catalog = useExactSavedHomeAuthenticationCatalog(profile);
    const label = resolveHomeDisplayLabel(profile, profile.id);
    const paneBack = props.backControl !== 'host';
    return (
        <View style={styles.pane} testID="already-use-happier.pane.home-sign-in">
            {paneBack ? (
                <HappierPressable testID="already-use-happier.another-way" accessibilityRole="button" onPress={props.onBack} style={styles.back}>
                    <Icon name="caret-left" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                    <Text style={styles.backText}>{t('homesJourneys.anotherWay')}</Text>
                </HappierPressable>
            ) : null}
            <PaneIdentityRow
                testID="already-use-happier.home-identity"
                mark={<HomeMark serverUrl={profile.canonicalServerUrl ?? profile.serverUrl} />}
                title={label}
                subtitle={`${toServerUrlDisplay(profile.canonicalServerUrl ?? profile.serverUrl)} · ${t('homesJourneys.homeReachable')}`}
                trailing={<PaneConfirmed label={t('homesJourneys.connected')} />}
            />
            <PaneHeader title={t('homesJourneys.signInToHomeTitle')} lead={t('homesJourneys.signInToHomeLead')} />
            {catalog.state === 'ready' ? (
                <HomeAuthenticationFlow
                    target={{ kind: 'saved_profile', profileRef: profile.id }}
                    actions={catalog.actions}
                    transport={catalog.transport ?? undefined}
                    keyChallengeV2Available={catalog.keyChallengeV2Available}
                    homeLabel={label}
                    returnTo="/"
                    onAuthenticated={props.onDone}
                    onBack={props.onBack}
                    showBackAction={paneBack}
                />
            ) : catalog.state === 'loading' ? (
                <SurfaceStateCard testID="already-use-happier.home-methods-loading" kind="loading"
                    title={t('homesJourneys.signInToHomeTitle')} accessibilitySemantics="status" />
            ) : (
                <SurfaceStateCard
                    testID="already-use-happier.home-methods-unavailable"
                    kind="error"
                    title={t('welcome.serverUnavailableTitle')}
                    reason={t('errors.operationFailed')}
                    accessibilitySemantics="alert"
                    action={{ label: t('common.retry'), onPress: catalog.retry }}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    pane: {
        gap: 14,
    },
    back: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        alignSelf: 'flex-start',
        minHeight: 24,
    },
    backText: {
        ...Typography.variant('meta', 'medium'),
        color: theme.colors.text.secondary,
    },
}));
