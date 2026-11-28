import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { formatSupporterNumber } from '@/components/plans/planSurfaceCopy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/ui/layout/layout';
import { fetchSupportersWall, type SupportersWall, type SupportersWallEntry } from '@/sync/api/supporters/fetchSupportersWall';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { t } from '@/text';

type CreditsState =
    | Readonly<{ status: 'loading' }>
    | Readonly<{ status: 'ready'; wall: SupportersWall }>
    | Readonly<{ status: 'error' }>;

function sinceYear(since: string | number): string {
    return typeof since === 'number' ? String(since) : since.slice(0, 4);
}

const keyExtractor = (entry: SupportersWallEntry) => String(entry.number);

/**
 * About › Credits (plan 04 U8): the opted-in supporters by number, from the public wall file.
 * One read per open, no polling; the list is virtualized so ten thousand names stay cheap.
 */
export const CreditsScreen = React.memo(function CreditsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [state, setState] = React.useState<CreditsState>({ status: 'loading' });
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);

    React.useEffect(() => {
        const controller = new AbortController();
        setState({ status: 'loading' });
        fetchSupportersWall(controller.signal).then(
            (wall) => setState({ status: 'ready', wall }),
            () => {
                if (!controller.signal.aborted) setState({ status: 'error' });
            },
        );
        return () => controller.abort();
    }, [attempt]);

    const renderItem = React.useCallback(({ item }: { item: SupportersWallEntry }) => (
        <Item
            title={item.name}
            subtitle={t('planSurface.creditsSince', { year: sinceYear(item.since) })}
            detail={`No. ${formatSupporterNumber(item.number)}`}
            showChevron={false}
            onPress={item.link ? () => { void openExternalUrl(item.link!); } : undefined}
        />
    ), []);

    if (state.status === 'loading') {
        return <View style={styles.center}><ActivityIndicator color={theme.colors.text.secondary} /></View>;
    }
    if (state.status === 'error') {
        return (
            <View style={styles.center} testID="credits-error">
                <Text style={styles.message}>{t('planSurface.creditsLoadFailed')}</Text>
                <RoundButton size="small" title={t('planSurface.retry')} onPress={retry} />
            </View>
        );
    }
    if (state.wall.entries.length === 0) {
        return (
            <View style={styles.center} testID="credits-empty">
                <Text style={styles.message}>{t('planSurface.creditsEmpty')}</Text>
                <RoundButton size="small" title={t('planSurface.supportCta')} onPress={() => router.push('/settings/plan')} />
            </View>
        );
    }
    return (
        <View style={styles.list}>
            <FlashList
                data={state.wall.entries}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                ListHeaderComponent={<Text style={styles.header}>{t('planSurface.creditsSubtitle')}</Text>}
            />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    list: {
        flex: 1,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
    },
    message: {
        ...Typography.default(),
        fontSize: 15,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    header: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.text.secondary,
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 8,
    },
}));
