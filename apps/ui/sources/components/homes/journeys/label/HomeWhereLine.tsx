import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { usePersonalHomeBootReadiness } from '@/components/personalHome/bootstrap/PersonalHomeBootstrapGate';
import { homeAdministrationOverviewPath } from '@/components/settings/home/governance/homeAdministrationRoutes';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { isPersonalHomeBootstrapRuntimeHost } from '@/utils/platform/personalHomeBootstrapHost';
import {
    getServerProfileById,
    isServerProfilePersonalHomeBootstrapCompleted,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

/**
 * Which Home this is and, honestly, where it lives (J1): "Personal Home · Lives on this computer ·
 * available while it's awake". The Home's name is the way into About your Home: a quiet link with an
 * info glyph, so the line stays facts rather than growing a separate "About your Home" link beside
 * them. No letter tile (a glyph is never set on a shape) and never a raw address: a Home without a
 * display name (published, given by the person, or "Personal Home") says nothing here — the Home
 * switcher names it. Where a Home lives is said only when this device knows it — the Personal Home it
 * runs itself (and "getting ready" while the boot owner `usePersonalHomeBootReadiness` starts it);
 * which computer hosts any other Home is not published yet (contract #1 `HomeHostFact`, deferred).
 */
export const HomeWhereLine = React.memo(function HomeWhereLine(props: Readonly<{
    /** `stacked` (phones): the name on one line, where it lives beneath. */
    layout?: 'inline' | 'stacked';
    /** `name`: only the Home's name (Home's status line while sessions are working). */
    detail?: 'full' | 'name';
    /** Joined after other facts on one line: a "·" goes before the name, only when there is one. */
    separated?: boolean;
}>) {
    const stacked = props.layout === 'stacked';
    const router = useRouter();
    const { theme } = useUnistyles();
    const active = useActiveServerSnapshot();
    const boot = usePersonalHomeBootReadiness();
    useServerProfilesGeneration();
    const profile = getServerProfileById(active.serverId);
    if (!profile) {
        // While this computer is still starting its Personal Home, the Home already has its name.
        if (boot.kind !== 'starting' || !boot.active) return null;
        return (
            <View style={styles.line} testID="home-where-line">
                <Text style={styles.text} numberOfLines={1}>
                    {props.separated ? '· ' : null}
                    <Text style={styles.name}>{t('personalHome.settings.defaultHomeLabel')}</Text>
                    {props.detail === 'name' ? null : ` · ${t('homesJourneys.livesOnThisComputer')} · ${t('homesJourneys.gettingReady')}`}
                </Text>
            </View>
        );
    }
    const name = resolveHomeDisplayName(profile);
    if (!name) return null;
    const hostedHere = isPersonalHomeBootstrapRuntimeHost() && isServerProfilePersonalHomeBootstrapCompleted(profile);
    const serverId = resolveServerProfileScopeId(profile);
    const facts = hostedHere && props.detail !== 'name'
        ? `${t('homesJourneys.livesOnThisComputer')} · ${t('homesJourneys.availableWhileAwake')}`
        : null;
    const nameLink = (
        <>
        {props.separated ? <Text style={styles.text}>·</Text> : null}
        <HappierPressable
            testID="home-where-line.about"
            accessibilityRole="link"
            accessibilityLabel={`${t('homesJourneys.aboutYourHome')}: ${name}`}
            onPress={() => router.push(homeAdministrationOverviewPath(serverId) as never)}
            style={styles.nameLink}
        >
            <Text style={styles.name} numberOfLines={1}>{name}</Text>
            <Icon name="info" size={13} color={theme.colors.text.tertiary} />
        </HappierPressable>
        </>
    );
    return (
        <View style={stacked ? styles.stack : styles.line} testID="home-where-line">
            {nameLink}
            {facts ? <Text style={styles.text} numberOfLines={stacked ? undefined : 1}>{stacked ? facts : `· ${facts}`}</Text> : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    stack: {
        gap: theme.space.s4,
        minWidth: 0,
    },
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
    },
    text: {
        flexShrink: 1,
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    name: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    nameLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        flexShrink: 0,
        maxWidth: '100%',
    },
}));
