import * as React from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { canPurchaseSupporterOffer, showSupporterOfferSheet } from '@/components/plans/offer/showSupporterOfferSheet';
import { usePlanSurfaceVisibility } from '@/components/settings/plans/usePlanSurfaceVisibility';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { log } from '@/log';
import { getAccountPlanEntry, refreshAccountPlan, useAccountPlanValue, type AccountPlanEntry } from '@/sync/domains/plans/accountPlanResource';
import { t, type TranslationKeyNoParams } from '@/text';

import { setAppIcon } from './appIconChoice';
import { resolveAppIconHost, type AppIconHost } from './appIconHost';
import { resolveAppIconAvailability, type AppIconAvailability } from './appIcons';
import { AppIconTile } from './AppIconTile';

const NAME_KEYS: Readonly<Record<string, TranslationKeyNoParams>> = {
    default: 'settingsAppearance.appIcon.names.default',
    night: 'settingsAppearance.appIcon.names.night',
    paper: 'settingsAppearance.appIcon.names.paper',
    gold: 'settingsAppearance.appIcon.names.gold',
    aurora: 'settingsAppearance.appIcon.names.aurora',
    sunrise: 'settingsAppearance.appIcon.names.sunrise',
    blueprint: 'settingsAppearance.appIcon.names.blueprint',
    pixel: 'settingsAppearance.appIcon.names.pixel',
};

export function appIconDisplayName(iconId: string): string {
    const key = NAME_KEYS[iconId];
    return key ? t(key) : iconId;
}

type SupporterState = 'unknown' | 'supporter' | 'not_supporter';

const selectSupporterState = (entry: AccountPlanEntry): SupporterState => {
    if (entry.data) return entry.data.supporter.active ? 'supporter' : 'not_supporter';
    // A failed or absent read leaves the six as Supporter icons; the person can still open the sheet.
    return entry.status === 'loading' || entry.status === 'idle' ? 'unknown' : 'not_supporter';
};
const selectOffer = (entry: AccountPlanEntry) => entry.data?.offers?.supporter ?? null;

function platformNoteKey(host: AppIconHost): TranslationKeyNoParams {
    if (host.kind === 'desktop') return 'settingsAppearance.appIcon.noteDesktop';
    return Platform.OS === 'android' ? 'settingsAppearance.appIcon.noteAndroid' : 'settingsAppearance.appIcon.noteIos';
}

/**
 * Appearance › App icon (plan 04 U6, lab `sp3Icons`). Two icons for everyone, six as a Supporter
 * thank-you. The pick goes to the device only: no server call, and the plan read happens only when
 * this device does not already hold one.
 */
export function AppIconScreen() {
    const router = useRouter();
    const host = React.useMemo(() => resolveAppIconHost(), []);
    const visibility = usePlanSurfaceVisibility();
    // Until the server's bits are known the six stay on screen, undecided; they leave only on a known "off".
    const supporterIconsOffered = visibility.visible || !visibility.resolved;
    const planSupporterState = useAccountPlanValue(selectSupporterState);
    const supporterState: SupporterState = visibility.resolved ? planSupporterState : 'unknown';
    const offer = useAccountPlanValue(selectOffer);
    const [currentIconId, setCurrentIconId] = React.useState<string | null>(null);
    const [pending, setPending] = React.useState(false);
    const [failed, setFailed] = React.useState(false);

    // One plan read when this device holds none, and none at all where the server has no plans surface.
    React.useEffect(() => {
        if (visibility.visible && getAccountPlanEntry().status === 'idle') void refreshAccountPlan();
    }, [visibility.visible]);

    React.useEffect(() => {
        if (!host) return undefined;
        let cancelled = false;
        host.readCurrentIconId().then(
            (iconId) => {
                if (!cancelled) setCurrentIconId(iconId);
            },
            (error: unknown) => log.log(`[appIcon] reading the current icon failed: ${error instanceof Error ? error.message : String(error)}`),
        );
        return () => {
            cancelled = true;
        };
    }, [host]);

    const entitlement = React.useMemo(() => ({
        supporterActive: supporterState === 'supporter',
        supporterIconsOffered,
    }), [supporterIconsOffered, supporterState]);
    const availability = React.useMemo(() => resolveAppIconAvailability(entitlement), [entitlement]);

    const options = React.useMemo((): SelectionTile<string>[] => availability.map(({ icon, locked }) => ({
        id: icon.id,
        title: appIconDisplayName(icon.id),
        // "Supporter" is the quiet subtitle of a locked tile: never a lock and never a blur.
        subtitle: locked && supporterState !== 'unknown' ? t('settingsAppearance.appIcon.supporterTag') : undefined,
        // Until the plan read answers, a supporter icon can be neither applied nor sold.
        disabled: locked && supporterState === 'unknown',
        preview: <AppIconTile iconId={icon.id} />,
    })), [availability, supporterState]);

    const choose = React.useCallback(async (iconId: string | null) => {
        if (!iconId || pending || iconId === currentIconId) return;
        const choice: AppIconAvailability | undefined = availability.find((entry) => entry.icon.id === iconId);
        if (!choice) return;
        if (choice.locked) {
            if (offer && canPurchaseSupporterOffer(offer)) showSupporterOfferSheet({ offer });
            else router.push('/settings/plan');
            return;
        }
        setPending(true);
        setFailed(false);
        try {
            const result = await setAppIcon(iconId, entitlement, host);
            if ('iconId' in result) setCurrentIconId(result.iconId);
            else setFailed(true);
        } catch (error) {
            log.log(`[appIcon] setting the icon failed: ${error instanceof Error ? error.message : String(error)}`);
            setFailed(true);
        } finally {
            setPending(false);
        }
    }, [availability, currentIconId, entitlement, host, offer, pending, router]);

    if (!host) {
        return (
            <ItemList style={styles.list}>
                <ItemGroup footer={t('settingsAppearance.appIcon.unsupported')}>{null}</ItemGroup>
            </ItemList>
        );
    }

    const intro = !supporterIconsOffered || supporterState === 'unknown'
        ? null
        : supporterState === 'supporter'
            ? t('settingsAppearance.appIcon.introSupporter')
            : t('settingsAppearance.appIcon.introLocked');

    const footer = failed
        ? t('settingsAppearance.appIcon.failed')
        : [intro, t(platformNoteKey(host))].filter(Boolean).join(' ');

    return (
        <ItemList style={styles.list}>
            <ItemGroup title={t('settingsAppearance.appIcon.chooseTitle')} footer={footer}>
                <View style={styles.tiles}>
                    <SelectionTiles
                        variant="visual"
                        testIdPrefix="settings-app-icon"
                        options={options}
                        value={currentIconId}
                        onChange={(next) => {
                            void choose(next);
                        }}
                    />
                </View>
            </ItemGroup>
        </ItemList>
    );
}

const styles = StyleSheet.create(() => ({
    list: {
        paddingTop: 0,
    },
    tiles: {
        padding: 12,
    },
}));
