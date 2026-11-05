import * as React from 'react';
import { RefreshControl, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

import { Redirect, Stack, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { managedMachineEnrolledDetailId } from '@/components/settings/machines/managed/managedCreationPresentation';
import { machineCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { useMachinesDoor } from './machinesDoor';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useManagedEnrolledMachine, useManagedMachineHeaderIdentity } from '@/components/settings/machines/managed/ManagedMachineSections';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { runRefreshDiagnosticAction } from '@/utils/system/userInteractionDiagnostics';
import { useDeviceType } from '@/utils/platform/responsive';

import { MachinePageHeader } from './MachinePageHeader';
import { MACHINE_PAGE_COLUMN, MachinePageListHostContext, MachinePageStateContext, type MachinePageState } from './machinePageContext';
import { useMachinePageScroll } from './machinePageScroll';
import { readRememberedMachinePageTab, rememberMachinePageTab } from './machinePageTabMemory';
import { isMachinePageTabPushed, isMachinePageTabRoot, machinePageTabQuery, machinePageTabRouteParams } from './machinePageTabQuery';
import { MACHINE_PAGE_TABS, resolveMachinePageTab } from './machinePageTabs';
import { MachineResourcesAskBlock } from '@/components/machines/resources/ask/MachineResourcesAskBlock';
import { MachinePageTabBodies } from './MachinePageTabBodies';
import type { MachinePageTabId, MachinePageTabParams, MachinePageTabBarAccessoryProps } from './machinePageTabQuery';
import { useMachinePageTarget, useMachinePageOnline, type MachinePageTarget } from './useMachinePageTarget';

const styles = StyleSheet.create(() => ({
    // The tab strip is the one divider between the identity and the tab's body: the same breath above and below it,
    // so a body that opens with a sentence (Guard) or a sheet (Overview) never touches the strip.
    tabsGroup: {
        paddingTop: PAGE_LIST_METRICS.pageHeaderColumnGapPx,
        paddingBottom: PAGE_LIST_METRICS.sheetInsetPx,
    },
    tabBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
    },
    ownedScroll: {
        flex: 1,
        minHeight: 0,
    },
    renameActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
    },
}));

/**
 * One machine's page (R1, R2), the same in both doors: its header, the tabs that exist (Overview
 * alone draws no bar), then the active tab's body. The tab is the route's `tab` query, switched in
 * place without a history entry; an absent `tab` returns to the tab last open on this machine.
 */
export function MachinePageScreen() {
    const target = useMachinePageTarget();
    const door = useMachinesDoor();
    const router = useRouter();
    const routeParams = useLocalSearchParams<Record<string, string>>();
    const { machine, machineId, serverId } = target;

    // A machine Happier created reads as what it is: its provider's mark, where it came from, and its
    // observed power and kind. The same read feeds the Overview's managed sections.
    const managedEnrolled = useManagedEnrolledMachine({ enrolledMachineId: machineId || undefined, serverId });
    const [refreshKey, bumpRefreshKey] = React.useReducer((value: number) => value + 1, 0);
    const { execute: refreshInventory } = useMountedActionExecution(serverId);
    const reload = React.useCallback(async () => {
        bumpRefreshKey();
        const result = await refreshInventory('machines.list', { serverId, refresh: true });
        if (!result.ok) throw new Error(result.error);
    }, [refreshInventory, serverId]);
    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const handleRefresh = React.useCallback(async () => {
        setIsRefreshing(true);
        try {
            await runRefreshDiagnosticAction({ action: 'pull_to_refresh', screen: 'machine_detail' }, reload);
        } finally {
            setIsRefreshing(false);
        }
    }, [reload]);

    const rename = useMachineRenameDraft(target);

    // An explicit tab in the link wins; otherwise the tab last open on this machine this session.
    const remembered = machineId ? readRememberedMachinePageTab({ serverId, machineId }) : null;
    const tab = resolveMachinePageTab(routeParams.tab ? routeParams : remembered ? machinePageTabQuery(remembered) : {});
    const setTabParams = React.useCallback((next: MachinePageTabParams) => {
        if (machineId) rememberMachinePageTab({ serverId, machineId }, next);
        // A tab is view state of this page: switching it replaces the query, not the history.
        router.setParams(machinePageTabRouteParams(next));
    }, [machineId, router, serverId]);
    const selectTab = React.useCallback((id: MachinePageTabId) => {
        const entry = MACHINE_PAGE_TABS.find(candidate => candidate.id === id);
        if (entry) setTabParams(entry.parseParams({ tab: id }));
    }, [setTabParams]);

    // The page header names the machine, so the native header keeps a plain, empty title. Hosted in
    // a Machines collection, the collection owns the navigation chrome: no second header.
    const hostedInCollection = useHappierCollectionLayout() !== null;
    const phone = useDeviceType() === 'phone';
    const headerBackTitle = t('machine.back');
    const screenOptions = React.useMemo(() => ({
        headerShown: !hostedInCollection,
        headerTitle: '',
        headerBackTitle,
    } as const), [headerBackTitle, hostedInCollection]);

    const pageState = React.useMemo((): MachinePageState => ({ target, managedEnrolled, refreshKey, reload }), [managedEnrolled, refreshKey, reload, target]);
    // One scroller for every tab and every page a tab pushes: a pushed page opens at its top (FA1 #9).
    const scroll = useMachinePageScroll(tab.params);
    const barAccessoriesInBar = MACHINE_PAGE_TABS.length > 1 && !phone;
    const machineName = target.machineSentenceName;
    const tabBody = React.useMemo(() => ({ serverId, machineId, machineName, setParams: setTabParams }),
        [machineId, machineName, serverId, setTabParams]);

    if (managedEnrolled.machine && !managedMachineEnrolledDetailId(managedEnrolled.machine)) {
        return <Redirect href={machineCollectionHref({ kind: 'managed', managedId: managedEnrolled.machine.id,
            serverId: managedEnrolled.serverId }, door) as never} />;
    }

    if (!machine) {
        // The page keeps its identity while the machine loads or when it no longer exists: the same
        // header with a placeholder name, then the state where the sections would be.
        return (
            <>
                <Stack.Screen options={screenOptions} />
                <ItemList pageColumn={MACHINE_PAGE_COLUMN}>
                    <MachinePageHeader target={target} managedIdentity={null} renaming={false} onRename={rename.start} />
                    <ItemGroup surface="none">
                        {target.isHydratingMachine ? (
                            <SurfaceStateCard testID="machine-detail-loading" kind="loading" title={t('common.loading')} />
                        ) : (
                            <SurfaceStateCard testID="machine-detail-not-found" kind="unavailable" title={t('machine.notFound')} />
                        )}
                    </ItemGroup>
                </ItemList>
            </>
        );
    }

    // A wide page draws the tab's accessory at the end of the tab bar (lab `rv` O); a phone keeps it in the body.
    const BarAccessory = barAccessoriesInBar ? tab.entry.BarAccessory : undefined;
    // On a phone a page a tab pushes (a service, a category, one process) is its own screen (lab `services/detailp`):
    // its way back, name and facts own the top, with no Machine header or tabs above them.
    const pushedOnPhone = phone && isMachinePageTabPushed(tab.params);
    const chrome = pushedOnPhone ? <>{rename.editor}</> : (
        <>
            <ManagedMachinePageHeader target={target} managedEnrolled={managedEnrolled} renaming={rename.saving} onRename={rename.start} />
            {MACHINE_PAGE_TABS.length > 1 ? (
                // In the page column like every section, so the tabs line up with the header and the sheets.
                <ItemGroup header="none" surface="none" style={styles.tabsGroup}>
                <View testID="machine-page-tabs" style={styles.tabBar}>
                    <SegmentedTabBar<MachinePageTabId>
                        role="tablist"
                        segmentSizing="content"
                        tabs={MACHINE_PAGE_TABS.map(entry => ({ id: entry.id, label: 'label' in entry && typeof entry.label === 'string' ? entry.label : t(entry.titleKey) }))}
                        activeTabId={tab.entry.id}
                        onSelectTab={selectTab}
                        accessibilityLabel={target.machineName}
                        testIDPrefix="machine-page-tab"
                    />
                    {BarAccessory ? <MachinePageBarAccessory Component={BarAccessory} serverId={serverId} machineId={machineId} params={tab.params} setParams={setTabParams} /> : null}
                </View>
                </ItemGroup>
            ) : null}
            {rename.editor}
        </>
    );
    const refreshControl = <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />;
    // A page that is too long to mount whole (Storage's Suggestions) draws its own virtualized scroller and leads it with this chrome.
    const ownsScroll = tab.entry.ownsScroll?.(tab.params) === true;
    const bodies = (
        <MachinePageTabBodies
            tabs={MACHINE_PAGE_TABS}
            active={tab}
            body={tabBody}
            barAccessoriesInBar={barAccessoriesInBar}
            // Ask an agent closes every Resources tab's root (plan 60 AGW-11), never a page the tab pushes; Overview places it before its machine sections.
            footer={<MachineResourcesAskBlock serverId={serverId} machineId={machineId} machineName={target.machineSentenceName} />}
            footerShown={tab.entry.id !== 'overview' && isMachinePageTabRoot(tab.params)}
            scrollOwned={ownsScroll}
        />
    );
    return (
        <MachinePageStateContext.Provider value={pageState}>
            <Stack.Screen options={screenOptions} />
            {ownsScroll ? (
                // The page draws its own page list (`VirtualizedItemList`) in the height the page has.
                <MachinePageListHostContext.Provider value={{ chrome, refreshControl }}>
                    <View style={styles.ownedScroll}>{bodies}</View>
                </MachinePageListHostContext.Provider>
            ) : (
                <ItemList
                    ref={scroll.ref}
                    onScroll={scroll.onScroll}
                    scrollEventThrottle={64}
                    // A created machine's receipt columns share the wide column too.
                    pageColumn={MACHINE_PAGE_COLUMN}
                    refreshControl={refreshControl}
                    keyboardShouldPersistTaps="handled"
                >
                    {chrome}
                    {bodies}
                </ItemList>
            )}
        </MachinePageStateContext.Provider>
    );
}

function ManagedMachinePageHeader(props: Readonly<{
    target: MachinePageTarget;
    managedEnrolled: ReturnType<typeof useManagedEnrolledMachine>;
    renaming: boolean;
    onRename(): void;
}>) {
    const online = useMachinePageOnline(props.target.serverId, props.target.machineId);
    const startedAt = props.target.machine?.daemonState?.startedAt;
    const managedIdentity = useManagedMachineHeaderIdentity(props.managedEnrolled.machine, props.managedEnrolled.serverId,
        { runningSince: online && typeof startedAt === 'number' ? startedAt : undefined });
    return <MachinePageHeader target={props.target} managedIdentity={managedIdentity} renaming={props.renaming} onRename={props.onRename} />;
}

function MachinePageBarAccessory(props: Omit<MachinePageTabBarAccessoryProps, 'online'> & Readonly<{
    Component: React.ComponentType<MachinePageTabBarAccessoryProps>;
}>) {
    const online = useMachinePageOnline(props.serverId, props.machineId);
    const { Component, ...body } = props;
    return <Component {...body} online={online} />;
}

/** Renaming in place under the header (the header `⋯` → Rename); the draft belongs to one machine and Home. */
function useMachineRenameDraft(target: ReturnType<typeof useMachinePageTarget>): Readonly<{
    start(): void;
    saving: boolean;
    editor: React.ReactNode;
}> {
    const { machine, machineId, serverId } = target;
    const metadataExecution = useMountedActionExecution(serverId);
    const [draft, setDraft] = React.useState<{ machineId: string; serverId: string; value: string } | null>(null);
    const [saving, setSaving] = React.useState(false);
    const current = draft && draft.machineId === machineId && areServerProfileIdentifiersEquivalent(draft.serverId, serverId) ? draft : null;
    React.useEffect(() => {
        setDraft((value) => value && value.machineId === machineId && areServerProfileIdentifiersEquivalent(value.serverId, serverId) ? value : null);
    }, [machineId, serverId]);

    const start = React.useCallback(() => {
        if (!machine || !machineId || saving) return;
        setDraft({ machineId, serverId, value: machine.metadata?.displayName || '' });
    }, [machine, machineId, saving, serverId]);

    const save = async () => {
        if (!machine || !machineId || !current || saving || target.isServerSwitching) return;
        const saved = current;
        setSaving(true);
        try {
            const execution = await metadataExecution.execute('machines.metadata.update', {
                serverId, machineId, expectedVersion: machine.metadataVersion,
                patch: { displayName: saved.value.trim() || null },
            });
            if (!execution.ok) throw new Error(execution.error);
            setDraft((value) => value === saved ? null : value);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('machine.renameFailed'));
            await sync.refreshMachines();
        } finally {
            setSaving(false);
        }
    };

    const editor = current && machine ? (
        <ItemGroup>
            <SectionContentRow>
                <FieldItem label={t('machine.renameTitle')} supportingText={t('machine.renameDescription')}>
                    <FieldTextInput
                        testID="machine-detail-name-input"
                        accessibilityLabel={t('machine.renameTitle')}
                        value={current.value}
                        placeholder={machine.metadata?.host || t('machine.renamePlaceholder')}
                        editable={!saving}
                        onChangeText={(value) => setDraft((previous) => previous ? { ...previous, value } : previous)}
                        onSubmitEditing={save}
                    />
                </FieldItem>
            </SectionContentRow>
            <SectionContentRow>
                <View style={styles.renameActions}>
                    <RoundButton testID="machine-detail-name-save" size="small" title={t('common.save')} loading={saving}
                        disabled={saving || target.isServerSwitching} action={save} />
                    <RoundButton testID="machine-detail-name-cancel" size="small" display="secondary" title={t('common.cancel')}
                        disabled={saving} onPress={() => setDraft(null)} />
                </View>
            </SectionContentRow>
        </ItemGroup>
    ) : null;

    return { start, saving, editor };
}
