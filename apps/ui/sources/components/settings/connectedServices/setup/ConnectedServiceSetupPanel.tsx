import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { SetupBlockGrid, type SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockPaper } from '@/components/ui/setupBlocks/SetupBlockPaper';
import { Text } from '@/components/ui/text/Text';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Typography } from '@/constants/Typography';
import { MachineAdministrationTargetSelector, type MachineAdministrationTargetSelectorProps } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection, type MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import type { ConnectedServiceId} from '@happier-dev/protocol/connect/connected-service-bindings';
import type { PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { useDeviceType } from '@/utils/platform/responsive';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { ConnectedAccountSetupController } from '../account/ConnectedAccountServiceView';
import type { ConnectedAccountSetupFacts } from '../account/useConnectedAccountSetupCompletion';
import { ConnectedServiceMark, formatAgentNames } from '../ConnectedServiceMark';
import type { ConnectedServicesIndexSection } from '../model/buildConnectedServicesIndexModel';
import { connectedServiceSetupCategory, connectedServiceSetupCategoryTitle, type ConnectedServiceSetupCategory } from './buildConnectedServiceSetupCatalog';
import type { ConnectedServiceRegistryEntry, ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { ConnectedServiceCatalogBlock } from './ConnectedServiceCatalogBlock';
import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import { namedByWhatYouPaste, presentNewConnectedAccountDraftTitle, signsInWithAnAccount } from './connectMoreBlocks';
import type { ConnectedServiceSetupTarget } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
export type { ConnectedServiceSetupTarget } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';

/** One service the catalog offers: what it is, who would use it, and how many you already have. */
export type ConnectedServiceSetupCatalogEntry = Readonly<{
    serviceKey: string;
    service: PluginContributionIdentityV1;
    entry: ConnectedServiceRegistryEntry | null;
    legacyServiceId: ConnectedServiceId | null;
    label: string;
    usedBy: readonly string[];
    /** The same agents by id (for their marks), in the same order. */
    usedByAgentIds: readonly string[];
    connectedCount: number;
    section: ConnectedServicesIndexSection;
    /** Shared setup/Add grouping, never setup or execution admission. */
    category?: ConnectedServiceSetupCategory;
    /** Current native execution or an explicitly declared Account-direct method can add an account. */
    canAdd: boolean;
    statusLine?: string | null;
    supportDetails?: string | null;
}>;

export type ConnectedServiceSetupPanelProps = Readonly<{
    target: ConnectedServiceSetupTarget;
    catalog: readonly ConnectedServiceSetupCatalogEntry[];
    onTargetChange: (target: ConnectedServiceSetupTarget) => void;
    onClose: () => void;
    /** The new or re-signed account: the panel's host settles it into its row. */
    onConnected?: (account: QualifiedConnectedAccountRef, serviceKey: string, facts?: ConnectedAccountSetupFacts) => void;
    /** Renders one service's flow; the live panel runs the service's controller (a fixture preview passes its own). */
    renderServiceFlow?: (entry: ConnectedServiceSetupCatalogEntry, target: ConnectedServiceSetupTarget) => React.ReactNode;
    /** A host's canonical selection input (dev frames supply a non-executable presentation fixture). */
    targetSelection?: MachineAdministrationTargetSelectionV1;
    initialMachineTarget?: MachineAdministrationTargetV1 | null;
    registry?: ConnectedServiceRegistrySnapshot;
    /** The enclosing page consumes this selected method's demand; the controller owns the choice. */
    onMachineRequirementChange?: (required: boolean, availability?: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability']) => void;
    /** Consumer-scoped setup must finish on its captured controller. */
    targetLocked?: boolean;
    /** A use no agent signs in for leads with the service's declared default method (see the controller's panel intent). */
    methodOrder?: 'declaredDefault';
    /**
     * `frame` (default): the set-up block's frame is the paper (Connected services, Home).
     * `card`: the panel brings its own (the modal, where there is no block to grow from).
     * `sheet`: the Connect sheet's card owns the frame and its header band (named by
     * `presentConnectedServiceSetupHeading`); the panel draws only the body, a service's flow directly.
     */
    chrome?: 'frame' | 'card' | 'page' | 'sheet';
    /**
     * `page` chrome only: what the page offers beside signing a new account in (choose an account you
     * already have), set directly under the page's one header and above the sign-in.
     */
    lead?: React.ReactNode;
    /**
     * `all`: every service, the "Signed in on a machine?" explainer, code hosts and tools, and the
     * Providers pointer (Connected services). `home`: only the services the host passes, with Home's
     * copy (lab H2c).
     */
    scope?: 'all' | 'home';
    testID?: string;
}>;

/**
 * The one heading of a setup surface: its title and one line of purpose, for the panel's own head, a
 * page header, or the Connect sheet's band.
 */
export function presentConnectedServiceSetupHeading(input: Readonly<{
    selected: ConnectedServiceSetupCatalogEntry | null;
    targetKind: ConnectedServiceSetupTarget['kind'];
    scope: 'all' | 'home';
    chrome?: ConnectedServiceSetupPanelProps['chrome'];
    /** The chosen method's own demand: the same fact that shows the Machine chip. */
    machineRequired: boolean;
}>): Readonly<{ title: string; purpose: string }> {
    const { selected, scope } = input;
    const title = !selected
        ? scope === 'home' ? t('connectedServicesSetup.homeCatalogTitle') : t('connectedServicesSettings.setupCatalogTitle')
        : input.targetKind === 'reconnect'
            ? t('connectedServicesSettings.setupReconnectTitle', { service: selected.label })
            // On its page an added account is a draft in the collection: the page is named like its row.
            : input.chrome === 'page'
                ? presentNewConnectedAccountDraftTitle(selected)
                : t('connectedServicesSettings.setupServiceTitle', { service: selected.label });
    const purpose = !selected
        ? scope === 'home' ? t('connectedServicesSetup.homeCatalogPurpose') : t(input.machineRequired ? 'connectedServicesSettings.setupCatalogPurpose' : 'connectedServicesSettings.setupCatalogPurposeNoMachine')
        : selected.usedBy.length > 0 && namedByWhatYouPaste(selected)
            // A key is not "your account": who can use it, as its Connect card says.
            ? t('connectedServicesSetup.serviceCanUse', { agents: formatAgentNames(selected.usedBy) })
        : selected.usedBy.length > 0
            ? t('connectedServicesSettings.setupServicePurpose', { agents: formatAgentNames(selected.usedBy) })
            // A service no agent signs in with says what it is for in its declaration's words.
            : resolveProjectedLocalizedText(selected.entry?.projectedDescription)
                || t('connectedServicesSettings.setupServicePurposeNoAgents');
    return { title, purpose };
}

const OWN_LOGIN_BLOCK_ID = '__own-login';
/** The groups behind a disclosure, in the Add menu's order; agent sign-in is the page's lead grid. */
const OTHER_GROUPS = ['code-tools', 'cloud-machines', 'plugins'] as const satisfies readonly ConnectedServiceSetupCategory[];



/** One non-agent group of the catalog: a disclosure naming it with a few marks, opening its blocks. */
function ConnectedServiceSetupGroup(props: Readonly<{
    category: ConnectedServiceSetupCategory;
    title: string;
    entries: readonly ConnectedServiceSetupCatalogEntry[];
    items: readonly SetupBlockItem[];
    expanded: boolean;
    /** The group is the page's only content or holds the open service, so its header is not a control. */
    headerHidden: boolean;
    columns: 1 | 3;
    openId: string | null;
    onExpandedChange: (category: ConnectedServiceSetupCategory, open: boolean) => void;
    onOpenChange: (id: string | null) => void;
}>) {
    const { theme } = useUnistyles();
    const { category, onExpandedChange } = props;
    const setExpanded = React.useCallback((open: boolean) => onExpandedChange(category, open), [category, onExpandedChange]);
    return (
        <ExpandableItem
            testID={`connected-service-setup:group-disclosure:${category}`}
            expanded={props.expanded}
            onExpandedChange={setExpanded}
            showDivider={false}
            header={({ expanded, headerProps }) => !props.headerHidden ? (
                <Pressable
                    testID={`connected-service-setup:group:${category}`}
                    {...headerProps}
                    style={({ pressed }) => [styles.tools, pressed ? styles.toolsPressed : null]}
                >
                    <Text style={styles.toolsTitle}>{props.title}</Text>
                    <View style={styles.toolMarks}>{props.entries.slice(0, 3).map((entry) => <ConnectedServiceMark key={entry.serviceKey} legacyServiceId={entry.legacyServiceId} service={entry.service} size="inline" />)}</View>
                    <Text style={styles.toolsNames} numberOfLines={1}>
                        {formatAgentNames(props.entries.map((entry) => entry.label))}
                    </Text>
                    <DisclosureCaret expanded={expanded} size={16} />
                </Pressable>
            ) : null}
        >
            <SetupBlockGrid
                testID={`connected-service-setup:group-catalog:${category}`}
                frame="bare"
                columns={props.columns}
                items={props.items}
                openId={props.openId}
                onOpenChange={props.onOpenChange}
            />
        </ExpandableItem>
    );
}

/**
 * The set-up panel a Connect block grows into (lab `csvc` A1–A4, H2c): its head names where it is
 * (the catalog, or one service with ← back to it), the machine the sign-in runs on, and ✕. The catalog
 * is itself a row of set-up blocks — each service's plan, who uses it, how many you have — and each
 * block grows again, in place, into that service's flow. The flow is the service page's controller
 * (`ConnectedAccountSetupController`), so every command, form, recovery and resume is the one the
 * service page runs.
 */
export const ConnectedServiceSetupPanel = React.memo(function ConnectedServiceSetupPanel(props: ConnectedServiceSetupPanelProps) {
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const { theme } = useUnistyles();
    const router = useRouter();
    const phone = useDeviceType() === 'phone';
    const accountScope = useActiveServerAccountScope();
    const selectionKey = JSON.stringify([accountScope ? serverAccountScopeKeySuffix(accountScope) : null, props.target]);
    const [method, setMethod] = React.useState<Readonly<{ key: string; id: string | null }>>({ key: selectionKey, id: null });
    const selectedModeId = method.key === selectionKey ? method.id : null;
    const [machineDemand, setMachineDemand] = React.useState<Readonly<{ key: string; required: boolean;
        availability?: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability'] }> | null>(null);
    const machineRequired = machineDemand?.key === selectionKey ? machineDemand.required : false;
    const machineAvailability = machineDemand?.key === selectionKey ? machineDemand.availability : undefined;
    const reportMachineRequirement = React.useCallback((required: boolean, availability?: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability']) => setMachineDemand(current =>
        current?.key === selectionKey && current.required === required && current.availability === availability
            ? current : { key: selectionKey, required, availability }), [selectionKey]);
    const selectMode = React.useCallback((id: string) => setMethod({ key: selectionKey, id }), [selectionKey]);
    React.useLayoutEffect(() => props.onMachineRequirementChange?.(machineRequired, machineAvailability), [machineRequired, machineAvailability, props.onMachineRequirementChange]);
    const defaultTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts,
        { enabled: props.targetSelection === undefined && machineRequired,
            ...(props.initialMachineTarget !== undefined ? { initialTarget: props.initialMachineTarget } : {}) },
    );
    const targetSelection = props.targetSelection ?? defaultTargetSelection;
    const { target, catalog: liveCatalog, onClose, onTargetChange, onConnected } = props;
    // The chosen method's own demand decides; a catalog or an Account method needs no Machine (D21).
    const showTargetSelector = machineRequired;
    const scope = props.scope ?? 'all';
    const liveSelected = target.kind === 'catalog'
        ? null
        : liveCatalog.find((candidate) => candidate.serviceKey === target.serviceKey) ?? null;
    // Discovery owns available choices, not an already selected setup attempt.
    // Keep its presentation row and grid ancestry through refresh. The controller
    // still resolves fresh execution authority before every native operation.
    const [selection, setSelection] = React.useState(() => ({
        key: selectionKey, entry: liveSelected, category: liveSelected ? connectedServiceSetupCategory(liveSelected) : undefined,
    }));
    React.useLayoutEffect(() => {
        setSelection(current => {
            if (current.key !== selectionKey) return { key: selectionKey, entry: liveSelected, category: liveSelected ? connectedServiceSetupCategory(liveSelected) : undefined };
            if (!liveSelected || current.entry === liveSelected) return current;
            return { key: selectionKey, entry: liveSelected, category: current.category ?? connectedServiceSetupCategory(liveSelected) };
        });
    }, [liveSelected, selectionKey]);
    const retained = selection.key === selectionKey ? selection : null;
    const selected = liveSelected ?? retained?.entry ?? null;
    const selectedCategory = retained?.category ?? (selected ? connectedServiceSetupCategory(selected) : undefined);
    const catalog = selected && !liveSelected ? [...liveCatalog, selected] : liveCatalog;
    const selectedKey = selected?.serviceKey ?? null;

    // The group a service is shown under comes from the catalog's one category owner; a selected service
    // keeps the group it was opened from through a refresh.
    const categoryOf = (candidate: ConnectedServiceSetupCatalogEntry) =>
        candidate.serviceKey === selectedKey && selectedCategory ? selectedCategory : connectedServiceSetupCategory(candidate);
    // The plans people sign in with first (Claude, ChatGPT…), then keys; each group by name.
    const blocks = catalog
        .filter((candidate) => scope === 'home' || categoryOf(candidate) === 'agent-sign-in')
        .sort((left, right) => Number(signsInWithAnAccount(right)) - Number(signsInWithAnAccount(left)));
    const groups = scope === 'all' ? OTHER_GROUPS.map((category) => ({
        category, title: connectedServiceSetupCategoryTitle(category),
        entries: catalog.filter((candidate) => categoryOf(candidate) === category),
    })).filter((group) => group.entries.length > 0) : [];
    const selectedGroup = selected ? groups.find((group) => group.entries.some((candidate) => candidate.serviceKey === selected.serviceKey)) ?? null : null;
    const [openGroups, setOpenGroups] = React.useState<readonly ConnectedServiceSetupCategory[]>(selectedGroup ? [selectedGroup.category] : []);
    React.useEffect(() => {
        if (selectedGroup) setOpenGroups((current) => current.includes(selectedGroup.category) ? current : [...current, selectedGroup.category]);
    }, [selectedGroup]);
    const setGroupOpen = React.useCallback((category: ConnectedServiceSetupCategory, open: boolean) =>
        setOpenGroups((current) => open ? (current.includes(category) ? current : [...current, category]) : current.filter((candidate) => candidate !== category)), []);
    const agentSelected = selected !== null && blocks.some((candidate) => candidate.serviceKey === selected.serviceKey);
    // A service outside the catalog's blocks (signing an account in again where no machine publishes
    // the service to add another) shows its flow directly.
    const direct = selected !== null && (props.chrome === 'page' || props.chrome === 'sheet' || (!agentSelected && !selectedGroup));
    const showBack = selected !== null && (blocks.length + groups.reduce((count, group) => count + group.entries.length, 0)) > 1;
    const back = React.useCallback(() => {
        if (showBack) onTargetChange({ kind: 'catalog' });
        else onClose();
    }, [onClose, onTargetChange, showBack]);

    const { title, purpose } = presentConnectedServiceSetupHeading({ selected, targetKind: target.kind, scope, chrome: props.chrome, machineRequired });

    const handleConnected = React.useCallback((account: QualifiedConnectedAccountRef, facts?: ConnectedAccountSetupFacts) => {
        if (selectedKey) {
            if (facts) onConnected?.(account, selectedKey, facts);
            else onConnected?.(account, selectedKey);
        }
    }, [onConnected, selectedKey]);
    const reconnectAccountId = target.kind === 'reconnect' ? target.accountId : null;
    const controllerPanel = React.useMemo(() => ({
        intent: reconnectAccountId ? { kind: 'reconnect' as const, accountId: reconnectAccountId } : { kind: 'add' as const },
        onConnected: handleConnected,
        modeId: selectedModeId,
        ...(props.methodOrder ? { methodOrder: props.methodOrder } : {}),
        onModeChange: selectMode,
        onMachineRequirementChange: reportMachineRequirement,
        // Cancel leaves the sign-in where it stands: back to the services, or closed.
        onCancel: back,
    }), [back, handleConnected, props.methodOrder, reconnectAccountId, reportMachineRequirement, selectMode, selectedModeId]);

    const renderFlow = (entry: ConnectedServiceSetupCatalogEntry) => (
        <View style={styles.flow} testID="connected-service-setup:service-flow">
            {props.renderServiceFlow ? props.renderServiceFlow(entry, target) : (
                <ConnectedAccountSetupController
                    service={entry.service}
                    panel={controllerPanel}
                    targetSelection={targetSelection}
                    registry={props.registry}
                />
            )}
        </View>
    );

    const toItem = (candidate: ConnectedServiceSetupCatalogEntry): SetupBlockItem => ({
        id: candidate.serviceKey,
        renderTile: ({ open }) => (
            <ConnectedServiceCatalogBlock
                entry={candidate}
                localizePluginText={localizePluginText}
                layout={phone ? 'row' : 'card'}
                showCount={scope === 'all'}
                onConnect={open}
            />
        ),
        renderPanel: () => renderFlow(candidate),
    });
    const agentItems: SetupBlockItem[] = blocks.map(toItem);
    // "Signed in on a machine?" is about an agent's own login: it is relevant only while the catalog
    // offers a service an agent actually uses (an account-only cloud service has no such login).
    if (scope === 'all' && blocks.some((candidate) => candidate.usedBy.length > 0)) {
        agentItems.push({
            id: OWN_LOGIN_BLOCK_ID,
            renderTile: () => (
                <SetupBlockPaper testID="connected-service-setup:own-login" layout={phone ? 'row' : 'card'} appearance="dashed">
                    <Icon name="terminal" size={18} color={theme.colors.text.secondary} />
                    <View style={phone ? styles.explainerRowText : null}>
                        <Text style={styles.blockTitle}>{t('connectedServicesSettings.setupOwnLoginTitle')}</Text>
                        <Text style={styles.blockBody}>{t('connectedServicesSettings.setupOwnLoginBody')}</Text>
                    </View>
                </SetupBlockPaper>
            ),
        });
    }
    const onGridOpenChange = (id: string | null) => onTargetChange(id ? { kind: 'service', serviceKey: id } : { kind: 'catalog' });

    const head = (
        <View style={styles.head}>
            {showBack ? (
                <Pressable
                    testID="connected-service-setup:back"
                    accessibilityRole="button"
                    accessibilityLabel={t('connectedServicesSetup.back')}
                    onPress={back}
                    style={({ pressed }) => [styles.back, pressed ? styles.backPressed : null]}
                >
                    <Icon name="caret-left" size={14} color={theme.colors.text.secondary} />
                </Pressable>
            ) : null}
            <View style={styles.lead}>
                {selected
                    ? <ConnectedServiceMark legacyServiceId={selected.legacyServiceId} service={selected.service} size="row" />
                    : <Icon name="plug" size={18} color={theme.colors.text.secondary} />}
            </View>
            <View style={styles.headText}>
                <Text style={styles.title} accessibilityRole="header">{title}</Text>
                <Text style={styles.purpose}>{purpose}</Text>
            </View>
            <View style={styles.headActions}>
                {showTargetSelector ? (
                    <MachineAdministrationTargetSelector
                        selection={targetSelection}
                        resolveCandidateAvailability={machineAvailability}
                        disabled={props.targetLocked}
                        presentation="chip"
                        testIDPrefix="connected-service-setup-target"
                    />
                ) : null}
                <IconButton
                    testID="connected-service-setup:close"
                    iconName="x"
                    variant="plain"
                    accessibilityLabel={t('common.close')}
                    tooltip={t('common.close')}
                    onPress={onClose}
                />
            </View>
        </View>
    );

    // Only a catalog with nothing else on it shows its one group bare, without a disclosure to open.
    const soleGroup = agentItems.length === 0 && groups.length === 1;
    // A sheet's sign-in form takes the configuration rows' anatomy (label and helper beside a bordered field), as on a page.
    const body = direct && selected ? (props.chrome === 'sheet'
        ? <ListPresentationProvider value="page" pageInsets="contained">{renderFlow(selected)}</ListPresentationProvider>
        : renderFlow(selected)) : (
        <>
            {!selectedGroup && agentItems.length > 0 ? (
                <View style={styles.section}>
                    <SetupBlockGrid
                        testID="connected-service-setup:catalog"
                        frame="bare"
                        columns={phone ? 1 : 3}
                        items={agentItems}
                        openId={agentSelected ? selectedKey : null}
                        onOpenChange={onGridOpenChange}
                    />
                </View>
            ) : null}
            {!agentSelected ? groups.filter((group) => !selectedGroup || group === selectedGroup).map((group) => (
                <View key={group.category} style={styles.section}>
                    <ConnectedServiceSetupGroup
                        category={group.category}
                        title={group.title}
                        entries={group.entries}
                        items={group.entries.map(toItem)}
                        expanded={soleGroup || selectedGroup === group || openGroups.includes(group.category)}
                        headerHidden={soleGroup || selectedGroup === group}
                        columns={phone ? 1 : 3}
                        openId={selectedGroup === group ? selectedKey : null}
                        onExpandedChange={setGroupOpen}
                        onOpenChange={onGridOpenChange}
                    />
                </View>
            )) : null}
        </>
    );

    const pageHeader = (
        // The machine the sign-in runs on is context, not a quiet action: phones keep the chip on the page.
        <PageHeader title={title} description={purpose} alwaysShowTitle actionsPlacement="page"
            cancelAction={props.targetLocked ? { title: t('common.cancel'), onPress: onClose, testID: 'connected-service-setup:close' } : undefined}
            leading={selected ? <ConnectedServiceMark legacyServiceId={selected.legacyServiceId} service={selected.service} size="page" /> : <Icon name="plug" size={24} />}
            // An Account-saved key needs no machine, so only a machine-scoped method names one.
            actions={showTargetSelector ? <MachineAdministrationTargetSelector selection={targetSelection} resolveCandidateAvailability={machineAvailability} disabled={props.targetLocked} presentation="chip" testIDPrefix="connected-service-setup-target" /> : undefined} />
    );
    const onPage = props.chrome === 'page';
    const onSheet = props.chrome === 'sheet';
    // On a page the blocks and the footer sit in the page column like the header and every section: the
    // section owner caps and centres them (no card: the blocks are their own surfaces), so there is one edge.
    const inColumn = (node: React.ReactNode) => onPage
        ? <ItemGroup surface="none">{node}</ItemGroup>
        : node;
    const bodyBlock = (
        <View style={onPage ? styles.pageBody : onSheet ? styles.sheetBody : styles.body}>
            {/* In a sheet the machine a sign-in runs on stands in the sheet's band, beside its title (ConnectSheetContent). */}
            {body}
            {!selected && scope === 'home' ? (
                <Text style={styles.note}>{t('connectedServicesSettings.firstRunMeanwhile')}</Text>
            ) : null}
        </View>
    );
    // A page locked to one requested purpose lists only what satisfies it, so a pointer to Providers would not apply.
    const footBlock = !selected && scope === 'all' && !props.targetLocked ? (
        <View style={onPage ? styles.pageFoot : styles.foot}>
            <Icon name="cube" size={14} color={theme.colors.text.secondary} />
            <Text style={styles.footText}>{t('connectedServicesSettings.setupProvidersPointer')}</Text>
            <Pressable
                testID="connected-service-setup:open-providers"
                accessibilityRole="link"
                onPress={() => router.push('/(app)/settings/providers' as never)}
            >
                <Text style={styles.footLink}>{t('connectedServicesSettings.setupOpenProviders')}</Text>
            </Pressable>
        </View>
    ) : null;
    const content = (
        <View
            testID={props.testID ?? 'connected-service-setup'}
            accessibilityRole="summary"
            accessibilityLabel={title}
        >
            {onPage ? <>{pageHeader}{props.lead}</> : onSheet ? null : head}
            {inColumn(bodyBlock)}
            {footBlock ? inColumn(footBlock) : null}
        </View>
    );

    // A page draft (lab s2svc:code) is the account's page-to-be: header, then one "Sign-in" section whose
    // sheet holds the method choice and the running steps, the reassurance closing it. Sections size
    // themselves to the page column, so nothing here pads its own gutter.
    if (props.chrome === 'page' && direct && selected) return (
        <View testID={props.testID ?? 'connected-service-setup'} accessibilityRole="summary" accessibilityLabel={title}>
            {pageHeader}
            {props.lead}
            <ItemGroup title={t('connectedServicesSettings.detailSignInTitle')}>
                <SectionContentRow>{renderFlow(selected)}</SectionContentRow>
            </ItemGroup>
        </View>
    );
    return props.chrome === 'card' ? <SurfaceCard padding="none">{content}</SurfaceCard> : content;
});

const styles = StyleSheet.create((theme) => ({
    head: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingTop: theme.space.s16,
        paddingLeft: 18,
        paddingRight: 14,
        paddingBottom: 14,
        backgroundColor: theme.colors.surface.sectionTint,
    },
    lead: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    // On a phone the machine chip wraps under the title instead of squeezing it.
    headText: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 220,
        minWidth: 0,
    },
    headActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        marginLeft: 'auto',
    },
    title: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    purpose: {
        marginTop: 1,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    body: {
        paddingTop: theme.space.s16,
        paddingHorizontal: 18,
        paddingBottom: 18,
        gap: theme.space.s10,
    },
    // In a sheet the card supplies the gutter and the band above.
    sheetBody: {
        gap: theme.space.s12,
    },
    // On a page the section supplies the column and its edge.
    pageBody: {
        paddingTop: theme.space.s8,
        gap: theme.space.s10,
    },
    flow: {
        gap: theme.space.s16,
    },
    section: {
        gap: theme.space.s10,
    },
    sectionLabel: {
        ...Typography.variant('meta', 'medium'),
        color: theme.colors.text.secondary,
    },
    back: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s4,
        marginLeft: -4,
        paddingVertical: theme.space.s2,
        paddingHorizontal: theme.space.s4,
        borderRadius: 6,
    },
    toolMarks: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
    backPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    backText: {
        ...Typography.variant('meta', 'medium'),
        color: theme.colors.text.secondary,
    },
    blockTitle: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    blockBody: {
        marginTop: theme.space.s2,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    explainerRowText: {
        flex: 1,
        minWidth: 0,
    },
    tools: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        minHeight: 40,
        paddingHorizontal: theme.space.s12,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    toolsPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    toolsTitle: {
        ...Typography.variant('body', 'medium'),
        color: theme.colors.text.primary,
    },
    toolsNames: {
        flex: 1,
        minWidth: 0,
        ...Typography.variant('body'),
        color: theme.colors.text.tertiary,
    },
    note: {
        marginTop: theme.space.s2,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    foot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        paddingHorizontal: 18,
        paddingVertical: theme.space.s12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    pageFoot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        paddingTop: theme.space.s12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    footText: {
        flex: 1,
        minWidth: 0,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    footLink: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.primary,
    },
}));
