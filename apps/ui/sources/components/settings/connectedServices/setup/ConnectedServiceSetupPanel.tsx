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
import { t } from '@/text';

import { ConnectedAccountSetupController } from '../account/ConnectedAccountServiceView';
import { ConnectedServiceMark, formatAgentNames } from '../ConnectedServiceMark';
import type { ConnectedServicesIndexSection } from '../model/buildConnectedServicesIndexModel';
import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { ConnectedServiceCatalogBlock } from './ConnectedServiceCatalogBlock';
import { signsInWithAnAccount } from './connectMoreBlocks';

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
    /**
     * `frame` (default): the set-up block's frame is the paper (Connected services, Home).
     * `card`: the panel brings its own (the modal, where there is no block to grow from).
     */
    chrome?: 'frame' | 'card' | 'page';
    /**
     * `all`: every service, the "Signed in on a machine?" explainer, code hosts and tools, and the
     * Providers pointer (Connected services). `home`: only the services the host passes, with Home's
     * copy (lab H2c).
     */
    scope?: 'all' | 'home';
    testID?: string;
}>;

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
    const defaultTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts,
        { enabled: props.targetSelection === undefined },
    );
    const targetSelection = props.targetSelection ?? defaultTargetSelection;
    const { target, catalog, onClose, onTargetChange, onConnected } = props;
    const scope = props.scope ?? 'all';
    const selected = target.kind === 'catalog'
        ? null
        : catalog.find((candidate) => candidate.serviceKey === target.serviceKey) ?? null;
    const selectedKey = selected?.serviceKey ?? null;

    // The plans people sign in with first (Claude, ChatGPT…), then keys; each group by name.
    const blocks = catalog
        .filter((candidate) => scope === 'home' || candidate.section === 'agents')
        .sort((left, right) => Number(signsInWithAnAccount(right)) - Number(signsInWithAnAccount(left)));
    const tools = scope === 'all' ? catalog.filter((candidate) => candidate.section === 'tools') : [];
    const selectedIsTool = selected !== null && tools.some((candidate) => candidate.serviceKey === selected.serviceKey);
    const [toolsExpanded, setToolsExpanded] = React.useState(selectedIsTool);
    React.useEffect(() => {
        if (selectedIsTool) setToolsExpanded(true);
    }, [selectedIsTool]);
    const agentSelected = selected !== null && blocks.some((candidate) => candidate.serviceKey === selected.serviceKey);
    // A service outside the catalog's blocks (signing an account in again where no machine publishes
    // the service to add another) shows its flow directly.
    const direct = selected !== null && (props.chrome === 'page' || (!agentSelected && !selectedIsTool));
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
        // Cancel leaves the sign-in where it stands: back to the services, or closed.
        onCancel: back,
    }), [back, handleConnected, reconnectAccountId]);

    const renderFlow = (entry: ConnectedServiceSetupCatalogEntry) => (
        <View style={styles.flow} testID="connected-service-setup:service-flow">
            {props.renderServiceFlow ? props.renderServiceFlow(entry, target) : (
                <ConnectedAccountSetupController
                    service={entry.service}
                    panel={controllerPanel}
                    targetSelection={targetSelection}
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
                <MachineAdministrationTargetSelector
                    selection={targetSelection}
                    presentation="chip"
                    testIDPrefix="connected-service-setup-target"
                />
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

    const content = (
        <View
            testID={props.testID ?? 'connected-service-setup'}
            accessibilityRole="summary"
            accessibilityLabel={title}
        >
            {props.chrome === 'page' ? <PageHeader title={title} description={purpose} alwaysShowTitle
                leading={selected ? <ConnectedServiceMark legacyServiceId={selected.legacyServiceId} size="row" /> : <Icon name="plug" size={24} />}
                actions={<MachineAdministrationTargetSelector selection={targetSelection} presentation="chip" testIDPrefix="connected-service-setup-target" />} /> : head}
            <View style={styles.body}>
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
        gap: 12,
        paddingTop: 16,
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
        gap: 8,
        marginLeft: 'auto',
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 15.5,
        lineHeight: 21,
        color: theme.colors.text.primary,
    },
    purpose: {
        ...Typography.default(),
        marginTop: 1,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    body: {
        paddingTop: 16,
        paddingHorizontal: 18,
        paddingBottom: 18,
        gap: 10,
    },
    flow: {
        gap: 14,
    },
    section: {
        gap: 10,
    },
    sectionLabel: {
        ...Typography.default('medium'),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    back: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 4,
        marginLeft: -4,
        paddingVertical: 2,
        paddingHorizontal: 4,
        borderRadius: 6,
    },
    toolMarks: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    backPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    backText: {
        ...Typography.default('medium'),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    trust: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    trustText: {
        ...Typography.default(),
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    blockTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13.5,
        lineHeight: 19,
        color: theme.colors.text.primary,
    },
    blockBody: {
        ...Typography.default(),
        marginTop: 2,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    explainerRowText: {
        flex: 1,
        minWidth: 0,
    },
    tools: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 40,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    toolsPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    toolsTitle: {
        ...Typography.default('medium'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.primary,
    },
    toolsNames: {
        ...Typography.default(),
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.tertiary,
    },
    note: {
        ...Typography.default(),
        marginTop: 2,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    foot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 18,
        paddingVertical: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    footText: {
        ...Typography.default(),
        flex: 1,
        minWidth: 0,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    footLink: {
        ...Typography.default('semiBold'),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.primary,
    },
}));
