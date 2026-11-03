import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { SetupBlockGrid, type SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockPaper } from '@/components/ui/setupBlocks/SetupBlockPaper';
import { Text } from '@/components/ui/text/Text';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Typography } from '@/constants/Typography';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection, type MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import type { ConnectedServiceId, PluginContributionIdentityV1, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { useDeviceType } from '@/utils/platform/responsive';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { ConnectedAccountSetupController } from '../account/ConnectedAccountServiceView';
import { ConnectedServiceMark, formatAgentNames } from '../ConnectedServiceMark';
import type { ConnectedServicesIndexSection } from '../model/buildConnectedServicesIndexModel';
import type { ConnectedServiceRegistryEntry, ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { ConnectedServiceCatalogBlock } from './ConnectedServiceCatalogBlock';
import { namedByWhatYouPaste, presentNewConnectedAccountDraftTitle, signsInWithAnAccount } from './connectMoreBlocks';

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
    /** Only services an online machine publishes can be added. */
    canAdd: boolean;
    statusLine?: string | null;
    supportDetails?: string | null;
}>;

/** Where the setup panel is: choosing a service, adding an account to one, or signing an account in again. */
export type ConnectedServiceSetupTarget =
    | Readonly<{ kind: 'catalog' }>
    | Readonly<{ kind: 'service'; serviceKey: string }>
    | Readonly<{ kind: 'reconnect'; serviceKey: string; accountId: string }>;

export type ConnectedServiceSetupPanelProps = Readonly<{
    target: ConnectedServiceSetupTarget;
    catalog: readonly ConnectedServiceSetupCatalogEntry[];
    onTargetChange: (target: ConnectedServiceSetupTarget) => void;
    onClose: () => void;
    /** The new or re-signed account: the panel's host settles it into its row. */
    onConnected?: (account: QualifiedConnectedAccountRef, serviceKey: string) => void;
    /** Renders one service's flow; the live panel runs the service's controller (a fixture preview passes its own). */
    renderServiceFlow?: (entry: ConnectedServiceSetupCatalogEntry, target: ConnectedServiceSetupTarget) => React.ReactNode;
    /** A host's canonical selection input (dev frames supply a non-executable presentation fixture). */
    targetSelection?: MachineAdministrationTargetSelectionV1;
    initialMachineTarget?: MachineAdministrationTargetV1 | null;
    registry?: ConnectedServiceRegistrySnapshot;
    /** The enclosing page consumes this selected method's demand; the controller owns the choice. */
    onMachineRequirementChange?: (required: boolean) => void;
    /** Consumer-scoped setup must finish on its captured controller. */
    targetLocked?: boolean;
    /**
     * `frame` (default): the set-up block's frame is the paper (Connected services, Home).
     * `card`: the panel brings its own (the modal, where there is no block to grow from).
     */
    chrome?: 'frame' | 'card' | 'page' | 'sheet';
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
        ? scope === 'home' ? t('connectedServicesSetup.homeCatalogPurpose') : t('connectedServicesSettings.setupCatalogPurpose')
        : selected.usedBy.length > 0 && namedByWhatYouPaste(selected)
            // A key is not "your account": who can use it, as its Connect card says.
            ? t('connectedServicesSetup.serviceCanUse', { agents: formatAgentNames(selected.usedBy) })
        : selected.usedBy.length > 0
            ? t('connectedServicesSettings.setupServicePurpose', {
                agents: formatAgentNames(selected.usedBy),
                service: selected.label,
            })
            : t('connectedServicesSettings.setupServicePurposeNoAgents');
    return { title, purpose };
}

const OWN_LOGIN_BLOCK_ID = '__own-login';

/**
 * The set-up panel a Connect block grows into (lab `csvc` A1–A4, H2c): its head names where it is
 * (the catalog, or one service with ← back to it), the machine the sign-in runs on, and ✕. The catalog
 * is itself a row of set-up blocks — each service's plan, who uses it, how many you have — and each
 * block grows again, in place, into that service's flow. The flow is the service page's controller
 * (`ConnectedAccountSetupController`), so every command, form, recovery and resume is the one the
 * service page runs.
 */
export const ConnectedServiceSetupPanel = React.memo(function ConnectedServiceSetupPanel(props: ConnectedServiceSetupPanelProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const phone = useDeviceType() === 'phone';
    const accountScope = useActiveServerAccountScope();
    const selectionKey = JSON.stringify([accountScope ? serverAccountScopeKeySuffix(accountScope) : null, props.target]);
    const [method, setMethod] = React.useState<Readonly<{ key: string; id: string | null }>>({ key: selectionKey, id: null });
    const selectedModeId = method.key === selectionKey ? method.id : null;
    const [machineDemand, setMachineDemand] = React.useState<Readonly<{ key: string; required: boolean }> | null>(null);
    const machineRequired = machineDemand?.key === selectionKey ? machineDemand.required : false;
    const reportMachineRequirement = React.useCallback((required: boolean) => setMachineDemand(current =>
        current?.key === selectionKey && current.required === required ? current : { key: selectionKey, required }), [selectionKey]);
    const selectMode = React.useCallback((id: string) => setMethod({ key: selectionKey, id }), [selectionKey]);
    React.useLayoutEffect(() => props.onMachineRequirementChange?.(machineRequired), [machineRequired, props.onMachineRequirementChange]);
    const defaultTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts,
        { enabled: props.targetSelection === undefined && machineRequired,
            ...(props.initialMachineTarget !== undefined ? { initialTarget: props.initialMachineTarget } : {}) },
    );
    const targetSelection = props.targetSelection ?? defaultTargetSelection;
    const { target, catalog: liveCatalog, onClose, onTargetChange, onConnected } = props;
    const scope = props.scope ?? 'all';
    const liveSelected = target.kind === 'catalog'
        ? null
        : liveCatalog.find((candidate) => candidate.serviceKey === target.serviceKey) ?? null;
    // Discovery owns available choices, not an already selected setup attempt.
    // Keep its presentation row and grid ancestry through refresh. The controller
    // still resolves fresh execution authority before every native operation.
    const [selection, setSelection] = React.useState(() => ({
        key: selectionKey, entry: liveSelected, section: liveSelected?.section,
    }));
    React.useLayoutEffect(() => {
        setSelection(current => {
            if (current.key !== selectionKey) return { key: selectionKey, entry: liveSelected, section: liveSelected?.section };
            if (!liveSelected || current.entry === liveSelected) return current;
            return { key: selectionKey, entry: liveSelected, section: current.section ?? liveSelected.section };
        });
    }, [liveSelected, selectionKey]);
    const retained = selection.key === selectionKey ? selection : null;
    const selected = liveSelected ?? retained?.entry ?? null;
    const selectedSection = retained?.section ?? selected?.section;
    const catalog = selected && !liveSelected ? [...liveCatalog, selected] : liveCatalog;
    const selectedKey = selected?.serviceKey ?? null;

    // The plans people sign in with first (Claude, ChatGPT…), then keys; each group by name.
    const blocks = catalog
        .filter((candidate) => scope === 'home' || (candidate.serviceKey === selectedKey ? selectedSection : candidate.section) === 'agents')
        .sort((left, right) => Number(signsInWithAnAccount(right)) - Number(signsInWithAnAccount(left)));
    const tools = scope === 'all' ? catalog.filter((candidate) => (candidate.serviceKey === selectedKey ? selectedSection : candidate.section) === 'tools') : [];
    const selectedIsTool = selected !== null && tools.some((candidate) => candidate.serviceKey === selected.serviceKey);
    const [toolsExpanded, setToolsExpanded] = React.useState(selectedIsTool);
    React.useEffect(() => {
        if (selectedIsTool) setToolsExpanded(true);
    }, [selectedIsTool]);
    const agentSelected = selected !== null && blocks.some((candidate) => candidate.serviceKey === selected.serviceKey);
    // A service outside the catalog's blocks (signing an account in again where no machine publishes
    // the service to add another) shows its flow directly.
    const direct = selected !== null && (props.chrome === 'page' || props.chrome === 'sheet' || (!agentSelected && !selectedIsTool));
    const showBack = selected !== null && (blocks.length + tools.length) > 1;
    const back = React.useCallback(() => {
        if (showBack) onTargetChange({ kind: 'catalog' });
        else onClose();
    }, [onClose, onTargetChange, showBack]);

    const title = !selected
        ? scope === 'home' ? t('connectedServicesSetup.homeCatalogTitle') : t('connectedServicesSettings.setupCatalogTitle')
        : target.kind === 'reconnect'
            ? t('connectedServicesSettings.setupReconnectTitle', { service: selected.label })
            : t('connectedServicesSettings.setupServiceTitle', { service: selected.label });
    const purpose = !selected
        ? scope === 'home' ? t('connectedServicesSetup.homeCatalogPurpose') : t('connectedServicesSettings.setupCatalogPurpose')
        : selected.usedBy.length > 0
            ? t('connectedServicesSettings.setupServicePurpose', {
                agents: formatAgentNames(selected.usedBy),
                service: selected.label,
            })
            : t('connectedServicesSettings.setupServicePurposeNoAgents');

    const handleConnected = React.useCallback((account: QualifiedConnectedAccountRef) => {
        if (selectedKey) onConnected?.(account, selectedKey);
    }, [onConnected, selectedKey]);
    const reconnectAccountId = target.kind === 'reconnect' ? target.accountId : null;
    const controllerPanel = React.useMemo(() => ({
        intent: reconnectAccountId ? { kind: 'reconnect' as const, accountId: reconnectAccountId } : { kind: 'add' as const },
        onConnected: handleConnected,
        modeId: selectedModeId,
        onModeChange: selectMode,
        onMachineRequirementChange: reportMachineRequirement,
        // Cancel leaves the sign-in where it stands: back to the services, or closed.
        onCancel: back,
    }), [back, handleConnected, reconnectAccountId, reportMachineRequirement, selectMode, selectedModeId]);

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
            <View style={styles.trust}>
                <Icon name="lock" size={14} color={theme.colors.text.secondary} />
                <Text style={styles.trustText}>{t('connectedServicesSettings.setupTrust')}</Text>
            </View>
        </View>
    );

    const toItem = (candidate: ConnectedServiceSetupCatalogEntry): SetupBlockItem => ({
        id: candidate.serviceKey,
        renderTile: ({ open }) => (
            <ConnectedServiceCatalogBlock
                entry={candidate}
                layout={phone ? 'row' : 'card'}
                showCount={scope === 'all'}
                onConnect={open}
            />
        ),
        renderPanel: () => renderFlow(candidate),
    });
    const agentItems: SetupBlockItem[] = blocks.map(toItem);
    if (scope === 'all') {
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
    const toolItems = tools.map(toItem);
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
                    ? <ConnectedServiceMark legacyServiceId={selected.legacyServiceId} size="row" />
                    : <Icon name="plug" size={18} color={theme.colors.text.secondary} />}
            </View>
            <View style={styles.headText}>
                <Text style={styles.title} accessibilityRole="header">{title}</Text>
                <Text style={styles.purpose}>{purpose}</Text>
            </View>
            <View style={styles.headActions}>
                {machineRequired ? (
                    <MachineAdministrationTargetSelector
                        selection={targetSelection}
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

    const body = direct && selected ? renderFlow(selected) : (
        <>
            {!selectedIsTool ? (
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
            {tools.length > 0 && !agentSelected ? (
                <View style={styles.section}>
                    <ExpandableItem
                        testID="connected-service-setup:tools-disclosure"
                        expanded={toolsExpanded || selectedIsTool}
                        onExpandedChange={setToolsExpanded}
                        showDivider={false}
                        header={({ expanded, headerProps }) => !selectedIsTool ? (
                            <Pressable
                                testID="connected-service-setup:tools"
                                {...headerProps}
                                style={({ pressed }) => [styles.tools, pressed ? styles.toolsPressed : null]}
                            >
                                <Text style={styles.toolsTitle}>{t('connectedServicesSettings.setupToolsTitle')}</Text>
                                <View style={styles.toolMarks}>{tools.slice(0, 3).map((tool) => <ConnectedServiceMark key={tool.serviceKey} legacyServiceId={tool.legacyServiceId} size="inline" />)}</View>
                                <Text style={styles.toolsNames} numberOfLines={1}>
                                    {formatAgentNames(tools.map((tool) => tool.label))}
                                </Text>
                                <Icon name={expanded ? 'caret-up' : 'caret-down'} size={16} color={theme.colors.text.secondary} />
                            </Pressable>
                        ) : null}
                    >
                        <SetupBlockGrid
                            testID="connected-service-setup:tools-catalog"
                            frame="bare"
                            columns={phone ? 1 : 3}
                            items={toolItems}
                            openId={selectedIsTool ? selectedKey : null}
                            onOpenChange={onGridOpenChange}
                        />
                    </ExpandableItem>
                </View>
            ) : null}
        </>
    );

    const onSheet = props.chrome === 'sheet';
    const content = (
        <View
            testID={props.testID ?? 'connected-service-setup'}
            accessibilityRole="summary"
            accessibilityLabel={title}
        >
            {props.chrome === 'page' ? <PageHeader title={title} description={purpose} alwaysShowTitle
                cancelAction={props.targetLocked ? { title: t('common.cancel'), onPress: onClose, testID: 'connected-service-setup:close' } : undefined}
                leading={selected ? <ConnectedServiceMark legacyServiceId={selected.legacyServiceId} size="row" /> : <Icon name="plug" size={24} />}
                actions={<MachineAdministrationTargetSelector selection={targetSelection} disabled={props.targetLocked} presentation="chip" testIDPrefix="connected-service-setup-target" />} /> : onSheet ? null : head}
            <View style={onSheet ? styles.sheetBody : styles.body}>
                {body}
                {!selected && scope === 'home' ? (
                    <Text style={styles.note}>{t('connectedServicesSettings.firstRunMeanwhile')}</Text>
                ) : null}
            </View>
            {!selected && scope === 'all' ? (
                <View style={styles.foot}>
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
            ) : null}
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
    sheetBody: {
        gap: theme.space.s12,
    },
    flow: {
        gap: 14,
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
    trust: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    trustText: {
        flex: 1,
        minWidth: 0,
        ...Typography.variant('meta'),
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
