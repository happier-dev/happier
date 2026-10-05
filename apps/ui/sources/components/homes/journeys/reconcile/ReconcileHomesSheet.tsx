import * as React from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';
import { HomeMark } from '@/components/homes/HomeMark';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { resolveServerProfileScopeId, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { selectAllHomes } from '@/sync/domains/server/selection/homeViewSelectionState';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { readViewportClass, useViewportClass } from '@/utils/platform/useViewportClass';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { PaneConfirmed } from '../alreadyUse/journeyPaneKit';
import { useHomesReconcileState } from '../useHomesJourneyState';
import { EmptyPersonalHomeOption, useEmptyPersonalHomeChoice } from './EmptyPersonalHomeOption';

function profileById(profiles: readonly ServerProfile[], id: string): ServerProfile | null {
    return profiles.find((profile) => resolveServerProfileScopeId(profile) === id) ?? null;
}

/**
 * "Your Homes are connected" (J2): shown when a sign-in, a Home link or an address connected Homes
 * beside the Personal Home this computer made. It confirms what already happened, then asks the one
 * real decision — where this computer's new sessions go — with "Keep both" always there. "Use …"
 * focuses that Home and hands over to this computer's setup for it (the canonical machine setup
 * owner, which moves or adds this computer's background service). Removing the empty Personal Home
 * is offered only when the Home says it is empty.
 */
export function ReconcileHomesSheet(props: CustomModalInjectedProps) {
    const { offer, profiles, settle } = useHomesReconcileState();
    const found = React.useMemo(
        () => (offer?.foundHomeIds ?? []).map((id) => profileById(profiles, id)).filter((profile): profile is ServerProfile => profile !== null),
        [offer, profiles],
    );
    const personal = offer ? profileById(profiles, offer.personalHomeId) : null;
    if (found.length === 0) {
        // Settled elsewhere (or the Homes went away) while the sheet was open.
        return null;
    }
    return <ReconcileHomesContent found={found} personal={personal} settle={settle} onClose={props.onClose} />;
}

/** The sheet's body for a known set of found Homes (the Personal Home last among the choices). */
export function ReconcileHomesContent(props: Readonly<{
    found: readonly ServerProfile[];
    personal: ServerProfile | null;
    settle: () => void;
    onClose: () => void;
}>) {
    const router = useRouter();
    const phone = useViewportClass() === 'compact';
    const { theme } = useUnistyles();
    const { found, personal, settle, onClose } = props;
    const choices = React.useMemo(() => [...found, ...(personal ? [personal] : [])], [found, personal]);
    const [runInId, setRunInId] = React.useState<string | null>(null);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const emptyChoice = useEmptyPersonalHomeChoice(personal);
    const selectedId = runInId ?? (found[0] ? resolveServerProfileScopeId(found[0]) : null);
    const selected = selectedId ? profileById(choices, selectedId) : null;
    const selectedIsPersonal = Boolean(personal && selected && resolveServerProfileScopeId(personal) === selectedId);

    const keepBoth = React.useCallback(() => {
        settle();
        onClose();
    }, [onClose, settle]);
    const showSessions = React.useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
            await selectAllHomes({ scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()) });
            settle();
            onClose();
        } finally {
            setBusy(false);
        }
    }, [busy, onClose, settle]);
    const useSelected = React.useCallback(async () => {
        if (!selected || busy) return;
        setBusy(true);
        try {
            settle();
            const switched = await setActiveServerAndSwitch({ serverId: selected.id, scope: 'device' });
            onClose();
            if (switched === 'blocked') return;
            // Only once this computer has left it: the empty Personal Home, when chosen, goes.
            await emptyChoice.commit();
            const navigation = runGuardedNavigation(() => router.push(buildMachineAddHref({ path: 'thisComputer' }) as never));
            if (navigation !== true) fireAndForget(navigation, { tag: 'ReconcileHomesSheet.setupThisComputer' });
        } finally {
            setBusy(false);
        }
    }, [busy, emptyChoice, onClose, router, selected, settle]);

    const menuItems = choices.map((profile) => ({
        id: resolveServerProfileScopeId(profile),
        title: resolveHomeDisplayLabel(profile, profile.id),
        icon: <HomeMark serverUrl={profile.canonicalServerUrl ?? profile.serverUrl} />,
    }));

    return (
        <ListPresentationProvider value="page">
        <View style={styles.body} testID="reconcile-homes">
            <ItemGroup title={phone ? undefined : t('homesJourneys.reconcileFound')}>
                {found.map((profile) => {
                    const id = resolveServerProfileScopeId(profile);
                    const label = resolveHomeDisplayLabel(profile, profile.id);
                    return (
                        <Item
                            key={id}
                            testID={`reconcile-homes.found.${id}`}
                            icon={<HomeMark serverUrl={profile.canonicalServerUrl ?? profile.serverUrl} />}
                            title={label}
                            showChevron={false}
                            rightElement={<PaneConfirmed label={t('homesJourneys.connected')} dotOnly={phone} />}
                        />
                    );
                })}
            </ItemGroup>
            {phone ? (
                <View style={styles.phoneAction}>
                    <RoundButton testID="reconcile-homes.show-sessions" title={t('homesJourneys.phone.showMySessions')}
                        loading={busy} onPress={() => { void showSessions(); }} />
                </View>
            ) : <>
            <ItemGroup title={t('homesJourneys.reconcileThisComputer')}>
                <DropdownMenu
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    items={menuItems}
                    selectedId={selectedId}
                    onSelect={(id) => setRunInId(id)}
                    trigger={({ open, toggle, selectedItem }) => (
                        <Item testID="reconcile-homes.run-in" title={t('homesJourneys.runSessionsIn')}
                            subtitle={t('homesJourneys.runSessionsInDescription')} subtitleLines={0}
                            accessoryLayout="adaptive" showChevron={false} onPress={toggle} accessibilityExpanded={open}
                            rightElement={renderDropdownItemTriggerRightElement({
                                detail: selectedItem?.title ?? null, open,
                                detailColor: theme.colors.text.secondary, chevronColor: theme.colors.text.secondary,
                                field: resolveFieldBoxColors(theme), leading: selectedItem?.icon,
                            })} />
                    )}
                />
            </ItemGroup>
            <EmptyPersonalHomeOption choice={emptyChoice} detail={t('homesJourneys.removeEmptyPersonalHomeDescription')} />
            <View style={styles.footer}>
                <Text style={styles.footerNote}>{t('homesJourneys.changeLater')}</Text>
                <View style={styles.footerActions}>
                    <RoundButton
                        testID="reconcile-homes.keep-both"
                        size="small"
                        display="secondary"
                        title={t('homesJourneys.keepBoth')}
                        onPress={keepBoth}
                    />
                    {selected && !selectedIsPersonal ? (
                        <RoundButton
                            testID="reconcile-homes.use"
                            size="small"
                            title={t('homesJourneys.useHome', { home: resolveHomeDisplayLabel(selected, selected.id) })}
                            loading={busy}
                            onPress={() => { void useSelected(); }}
                        />
                    ) : null}
                </View>
            </View>
            </>}
        </View>
        </ListPresentationProvider>
    );
}

/** Opens the sheet: automatically right after a sign-in connected Homes, or from its setup tile. */
export function presentReconcileHomesSheet(input: Readonly<{ foundCount: number }>): string {
    const phone = readViewportClass() === 'compact';
    return Modal.show({
        component: ReconcileHomesSheet,
        closeOnBackdrop: true,
        chrome: {
            kind: 'card',
            leading: <HeaderLogo size={32} />,
            title: t(phone ? 'homesJourneys.phone.reconcileTitle' : 'homesJourneys.reconcileTitle'),
            subtitle: phone ? t('homesJourneys.phone.reconcileLead') : t('homesJourneys.reconcileLead', { count: input.foundCount }),
            phonePresentation: 'sheet',
            dimensions: { width: 560 },
            testID: 'reconcile-homes-sheet',
        },
    });
}

const styles = StyleSheet.create((theme) => ({
    body: {
        paddingBottom: 16,
    },
    phoneAction: { paddingHorizontal: 20 },
    footer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 20,
        paddingTop: 8,
    },
    footerNote: {
        ...Typography.default(),
        flex: 1,
        minWidth: 160,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    footerActions: {
        flexDirection: 'row',
        gap: 8,
    },
}));
