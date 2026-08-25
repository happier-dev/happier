import * as React from 'react';
import { AccessibilityInfo, Platform, Pressable, View } from 'react-native';
import type { ViewToken } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { PluginDiagnosticsSection } from '@/components/settings/plugins/diagnostics/PluginDiagnosticsSection';
import { Modal } from '@/modal';
import { t } from '@/text';
import { restoreFocusToBestTarget } from '@/keyboard/focusReturn';
import type { PluginDiagnosticDataV1 } from '@happier-dev/protocol';
import type { PluginSessionHookInstallPreviewV1 } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';

import {
    filterExternalSessionsAutoLinkSources,
    filterExternalSessionsIntegrations,
    isExternalSessionsIntegrationInventoryActionable,
    readExternalSessionsIntegrationDiagnostic,
    resolveExternalSessionsIntegrationActions,
    type ExternalSessionsAutoLinkSourceDescriptor,
    type ExternalSessionsIntegrationAction,
    type ExternalSessionsIntegrationDescriptor,
    type ExternalSessionsIntegrationOperations,
    type ExternalSessionsQualifiedAgent,
} from './externalSessionsIntegrationModel';
import type {
    ExternalSessionsIntegrationInventoryState,
} from './externalSessionsIntegrationController';

export type ExternalSessionsSettingsSupplementalRow = Readonly<{
    key: string;
    render: () => React.ReactElement;
}>;

type ExternalSessionsIntegrationVirtualizedRow =
    | Readonly<{
        kind: 'integration_chunk';
        key: string;
        integrations: readonly ExternalSessionsIntegrationDescriptor[];
        first: boolean;
        last: boolean;
    }>
    | Readonly<{
        kind: 'diagnostic';
        key: string;
        integration: ExternalSessionsIntegrationDescriptor;
    }>
    | Readonly<{ kind: 'integrations_empty'; key: string; last: boolean }>
    | Readonly<{ kind: 'inventory_continuation'; key: string }>
    | Readonly<{ kind: 'privacy'; key: string }>
    | Readonly<{
        kind: 'auto_link_chunk';
        key: string;
        sources: readonly ExternalSessionsAutoLinkSourceDescriptor[];
        first: boolean;
        last: boolean;
    }>
    | Readonly<{
        kind: 'supplemental';
        key: string;
        render: () => React.ReactElement;
    }>;

type ExternalSessionsPendingFocusReturn =
    | Readonly<{
        kind: 'integration';
        agentIdentity: string;
        action: ExternalSessionsIntegrationAction;
        pendingKey: string;
    }>
    | Readonly<{
        kind: 'auto_link';
        sourceKey: string;
        pendingKey: string;
    }>;

function autoLinkSourceKey(source: ExternalSessionsAutoLinkSourceDescriptor): string {
    return [
        source.machineId,
        source.agent.pluginId,
        source.agent.localId,
        source.sourcePolicyId,
    ].join('\u0000');
}

function integrationAgentIdentity(
    integration: ExternalSessionsIntegrationDescriptor,
): string {
    return [integration.machineId, integration.agent.pluginId, integration.agent.localId].join('\u0000');
}

function resolveStatusTitle(state: ExternalSessionsIntegrationDescriptor['state']): string {
    switch (state) {
        case 'not_installed':
            return t('externalSessions.settingsIntegrationStatusNotInstalled');
        case 'installed_enabled':
            return t('externalSessions.settingsIntegrationStatusEnabled');
        case 'installed_disabled':
            return t('externalSessions.settingsIntegrationStatusDisabled');
        case 'needs_attention':
            return t('externalSessions.settingsIntegrationStatusNeedsAttention');
        case 'unsupported':
            return t('externalSessions.settingsIntegrationStatusUnsupported');
        case 'unavailable':
            return t('externalSessions.settingsIntegrationStatusUnavailable');
    }
}

function resolveDiagnosticRemediation(diagnostic: PluginDiagnosticDataV1): string | null {
    const remediation = diagnostic.remediation;
    if (!remediation) return null;

    switch (remediation.kind) {
        case 'retry':
            return t('externalSessions.settingsIntegrationRemediationRetry');
        case 'openSettings':
            return t('externalSessions.settingsIntegrationRemediationOpenSettings', {
                path: remediation.path,
            });
        case 'selectAccount':
            return t('externalSessions.settingsIntegrationRemediationSelectAccount', {
                service: `${remediation.service.pluginId}/${remediation.service.localId}`,
            });
        case 'installDependency':
            return t('externalSessions.settingsIntegrationRemediationInstallDependency', {
                dependency: remediation.dependencyId,
            });
        case 'openUrl':
            return t('externalSessions.settingsIntegrationRemediationOpenUrl', {
                url: remediation.url,
            });
    }
}

function resolveDiagnosticMessage(diagnostic: PluginDiagnosticDataV1): string {
    const message = diagnostic.message
        ?? t('externalSessions.settingsIntegrationDiagnosticMessageUnavailable');
    const remediation = resolveDiagnosticRemediation(diagnostic);
    return remediation ? `${message} ${remediation}` : message;
}

function resolveActionTitle(action: ExternalSessionsIntegrationAction): string {
    switch (action) {
        case 'review_install':
            return t('externalSessions.settingsIntegrationActionReviewInstall');
        case 'disable':
            return t('externalSessions.settingsIntegrationActionDisable');
        case 'enable':
            return t('externalSessions.settingsIntegrationActionEnable');
        case 'uninstall':
            return t('externalSessions.settingsIntegrationActionUninstall');
        case 'check_again':
            return t('externalSessions.settingsIntegrationActionCheckAgain');
    }
}

function resolveActionIcon(action: ExternalSessionsIntegrationAction): string {
    switch (action) {
        case 'review_install':
            return 'document-text-outline';
        case 'disable':
            return 'pause-circle-outline';
        case 'enable':
            return 'play-circle-outline';
        case 'uninstall':
            return 'trash-outline';
        case 'check_again':
            return 'refresh-outline';
    }
}

function resolveActionOperation(
    action: Exclude<ExternalSessionsIntegrationAction, 'review_install'>,
    operations: ExternalSessionsIntegrationOperations,
): (integration: ExternalSessionsIntegrationDescriptor) => Promise<void> {
    switch (action) {
        case 'disable':
            return operations.disable;
        case 'enable':
            return operations.enable;
        case 'uninstall':
            return operations.uninstall;
        case 'check_again':
            return operations.checkAgain;
    }
}

function formatInstallPreview(preview: PluginSessionHookInstallPreviewV1): string {
    return preview.targets.map((target) => [
        target.absolutePath,
        ...target.changes.map((change) => [
            `${change.nativeEventName} · ${change.collectionId}`,
            change.entry.matcher ?? t('externalSessions.settingsIntegrationPreviewNoMatcher'),
            change.entry.hooks[0].command,
        ].join('\n')),
    ].join('\n')).join('\n\n');
}

export const ExternalSessionsIntegrationSection = React.memo(function ExternalSessionsIntegrationSection(
    props: Readonly<{
        integrations?: readonly ExternalSessionsIntegrationDescriptor[] | null;
        autoLinkSources?: readonly ExternalSessionsAutoLinkSourceDescriptor[] | null;
        machineId: string | null;
        agent: ExternalSessionsQualifiedAgent | null;
        agentTitle?: string;
        operations?: ExternalSessionsIntegrationOperations | null;
        inventoryState?: ExternalSessionsIntegrationInventoryState;
        onRetryInventory?: (() => void | Promise<void>) | null;
        virtualized?: boolean;
        virtualizedHeader?: React.ReactElement | null;
        supplementalRows?: readonly ExternalSessionsSettingsSupplementalRow[];
        hasMoreInventory?: boolean;
        loadingMoreInventory?: boolean;
        onLoadMoreInventory?: (() => void | Promise<void>) | null;
    }>,
) {
    const { theme } = useUnistyles();
    const integrations = React.useMemo(
        () => props.integrations == null
            ? null
            : filterExternalSessionsIntegrations({
                integrations: props.integrations,
                machineId: props.machineId,
                agent: props.agent,
            }),
        [props.agent, props.integrations, props.machineId],
    );
    const autoLinkSources = React.useMemo(
        () => props.autoLinkSources == null
            ? null
            : filterExternalSessionsAutoLinkSources({
                sources: props.autoLinkSources,
                machineId: props.machineId,
                agent: props.agent,
            }),
        [props.agent, props.autoLinkSources, props.machineId],
    );
    const pendingKeysRef = React.useRef(new Set<string>());
    /**
     * A successful management action rewrites the row it was pressed on — Enable becomes
     * Disable, Review and Install becomes the installed actions — so the control the user
     * activated is gone by the time the result lands and nothing tells a screen-reader
     * user what happened. Remember the state each acted integration was in, keyed by its
     * stable Agent identity (its row key changes when an installation id appears), and
     * announce the new stable status once the mutation is actually reflected.
     */
    const announcedStateByAgentIdentityRef = React.useRef(new Map<string, ExternalSessionsIntegrationDescriptor['state']>());
    const [pendingKeys, setPendingKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const replacementActionRef = React.useRef<React.ComponentRef<typeof Pressable> | null>(null);
    const sectionFocusFallbackRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const pendingFocusReturnRef = React.useRef<ExternalSessionsPendingFocusReturn | null>(null);
    const operations = props.operations;
    const inventoryActionsDisabled = Boolean(
        props.inventoryState
        && !isExternalSessionsIntegrationInventoryActionable(props.inventoryState.status),
    );

    const armIntegrationFocusReturn = React.useCallback((
        integration: ExternalSessionsIntegrationDescriptor,
        action: ExternalSessionsIntegrationAction,
        pendingKey: string,
    ) => {
        replacementActionRef.current = null;
        pendingFocusReturnRef.current = {
            kind: 'integration',
            agentIdentity: integrationAgentIdentity(integration),
            action,
            pendingKey,
        };
    }, []);
    const armAutoLinkFocusReturn = React.useCallback((sourceKey: string, pendingKey: string) => {
        replacementActionRef.current = null;
        pendingFocusReturnRef.current = {
            kind: 'auto_link',
            sourceKey,
            pendingKey,
        };
    }, []);
    const discardPendingFocusReturn = React.useCallback((pendingKey: string) => {
        if (pendingFocusReturnRef.current?.pendingKey === pendingKey) {
            pendingFocusReturnRef.current = null;
        }
    }, []);
    const getReplacementActionRef = React.useCallback((
        integration: ExternalSessionsIntegrationDescriptor,
        actions: readonly ExternalSessionsIntegrationAction[],
        action: ExternalSessionsIntegrationAction,
    ) => {
        const pendingFocusReturn = pendingFocusReturnRef.current;
        return pendingFocusReturn?.kind === 'integration'
            && pendingFocusReturn.agentIdentity === integrationAgentIdentity(integration)
            && !actions.includes(pendingFocusReturn.action)
            && actions[0] === action
            ? replacementActionRef
            : undefined;
    }, []);

    const runAction = React.useCallback(async (
        integration: ExternalSessionsIntegrationDescriptor,
        action: ExternalSessionsIntegrationAction,
    ) => {
        const pendingKey = `${integration.key}:${action}`;
        if (
            !operations
            || inventoryActionsDisabled
            || pendingKeysRef.current.has(integration.key)
        ) return;

        pendingKeysRef.current.add(integration.key);
        setPendingKeys((current) => new Set(current).add(pendingKey));
        announcedStateByAgentIdentityRef.current.set(
            integrationAgentIdentity(integration),
            integration.state,
        );
        try {
            if (action === 'review_install') {
                await operations.reviewAndInstall(
                    integration,
                    async (preview) => {
                        const confirmed = await Modal.confirm(
                            t('externalSessions.settingsIntegrationReviewTitle', { agent: integration.agentTitle }),
                            t('externalSessions.settingsIntegrationReviewBody', {
                                entries: formatInstallPreview(preview),
                            }),
                            {
                                confirmText: t('externalSessions.settingsIntegrationActionInstall'),
                            },
                        );
                        if (confirmed) {
                            armIntegrationFocusReturn(integration, action, pendingKey);
                        }
                        return confirmed;
                    },
                );
                return;
            }
            if (action === 'uninstall') {
                const confirmed = await Modal.confirm(
                    t('externalSessions.settingsIntegrationUninstallTitle', { agent: integration.agentTitle }),
                    t('externalSessions.settingsIntegrationUninstallBody'),
                    {
                        confirmText: t('externalSessions.settingsIntegrationActionUninstall'),
                        destructive: true,
                    },
                );
                if (!confirmed) return;
            }
            armIntegrationFocusReturn(integration, action, pendingKey);
            await resolveActionOperation(action, operations)(integration);
        } catch {
            discardPendingFocusReturn(pendingKey);
            await Modal.alertAsync(
                t('common.error'),
                t('externalSessions.settingsIntegrationActionFailed'),
            );
        } finally {
            pendingKeysRef.current.delete(integration.key);
            setPendingKeys((current) => {
                if (!current.has(pendingKey)) return current;
                const next = new Set(current);
                next.delete(pendingKey);
                return next;
            });
        }
    }, [
        armIntegrationFocusReturn,
        discardPendingFocusReturn,
        inventoryActionsDisabled,
        operations,
    ]);

    React.useEffect(() => {
        const awaited = announcedStateByAgentIdentityRef.current;
        if (awaited.size === 0 || !integrations) return;
        for (const integration of integrations) {
            const identity = integrationAgentIdentity(integration);
            if (!awaited.has(identity)) continue;
            if (awaited.get(identity) === integration.state) continue;
            awaited.delete(identity);
            announceAccessibilityMessage(
                `${integration.agentTitle} · ${resolveStatusTitle(integration.state)}`,
            );
        }
    }, [integrations]);

    const runAutoLinkChange = React.useCallback(async (
        source: ExternalSessionsAutoLinkSourceDescriptor,
        enabled: boolean,
    ) => {
        const sourceKey = autoLinkSourceKey(source);
        const pendingKey = `${sourceKey}:auto_link`;
        if (
            !source.canChange
            || pendingKeysRef.current.has(sourceKey)
        ) return;
        pendingKeysRef.current.add(sourceKey);
        setPendingKeys((current) => new Set(current).add(pendingKey));
        try {
            armAutoLinkFocusReturn(sourceKey, pendingKey);
            await source.setEnabled(enabled);
        } catch {
            discardPendingFocusReturn(pendingKey);
            await Modal.alertAsync(
                t('common.error'),
                t('externalSessions.settingsAutoLinkUpdateFailed'),
            );
        } finally {
            pendingKeysRef.current.delete(sourceKey);
            setPendingKeys((current) => {
                if (!current.has(pendingKey)) return current;
                const next = new Set(current);
                next.delete(pendingKey);
                return next;
            });
        }
    }, [armAutoLinkFocusReturn, discardPendingFocusReturn]);

    React.useEffect(() => {
        const pendingFocusReturn = pendingFocusReturnRef.current;
        if (!pendingFocusReturn || pendingKeys.has(pendingFocusReturn.pendingKey)) return;

        if (pendingFocusReturn.kind === 'integration') {
            if (integrations === null) return;
            const integration = integrations.find((candidate) => (
                integrationAgentIdentity(candidate) === pendingFocusReturn.agentIdentity
            ));
            const actions = integration
                ? resolveExternalSessionsIntegrationActions(integration, operations)
                : [];

            // A refresh can leave Check Again (or a stale action) in place. It is still the
            // current control, so moving focus would take it away from the user.
            if (actions.includes(pendingFocusReturn.action)) {
                pendingFocusReturnRef.current = null;
                return;
            }

            pendingFocusReturnRef.current = null;
            restoreFocusToBestTarget(replacementActionRef, sectionFocusFallbackRef);
            return;
        }

        if (autoLinkSources === null) return;
        if (autoLinkSources.some((source) => (
            autoLinkSourceKey(source) === pendingFocusReturn.sourceKey
        ))) {
            pendingFocusReturnRef.current = null;
            return;
        }

        pendingFocusReturnRef.current = null;
        restoreFocusToBestTarget(replacementActionRef, sectionFocusFallbackRef);
    }, [autoLinkSources, integrations, operations, pendingKeys]);

    const inventoryStatus = props.inventoryState?.status;
    const inventoryTitle = inventoryStatus === 'loading'
        ? t('externalSessions.settingsIntegrationInventoryLoadingTitle')
        : inventoryStatus === 'partial'
            ? t('externalSessions.settingsIntegrationInventoryPartialTitle')
            : inventoryStatus === 'error'
                ? t('externalSessions.settingsIntegrationInventoryErrorTitle')
                : null;
    const inventorySubtitle = inventoryStatus === 'loading'
        ? t('externalSessions.settingsIntegrationInventoryLoadingSubtitle')
        : inventoryStatus === 'partial'
            ? t('externalSessions.settingsIntegrationInventoryPartialSubtitle')
            : inventoryStatus === 'error'
                ? t('externalSessions.settingsIntegrationInventoryErrorSubtitle')
                : null;
    const inventoryAnnouncement = inventoryTitle && inventorySubtitle
        ? `${inventoryTitle}. ${inventorySubtitle}`
        : null;
    const lastIosInventoryAnnouncementRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;
        if (!inventoryAnnouncement) {
            lastIosInventoryAnnouncementRef.current = null;
            return;
        }
        if (lastIosInventoryAnnouncementRef.current === inventoryAnnouncement) return;
        lastIosInventoryAnnouncementRef.current = inventoryAnnouncement;
        try {
            AccessibilityInfo.announceForAccessibility(inventoryAnnouncement);
        } catch {
            // Accessibility announcements are best effort on native platforms.
        }
    }, [inventoryAnnouncement]);

    const virtualizedRows = React.useMemo<readonly ExternalSessionsIntegrationVirtualizedRow[]>(() => {
        if (!props.virtualized) return [];
        const rows: ExternalSessionsIntegrationVirtualizedRow[] = [];
        if (integrations !== null) {
            const hasInventoryContinuation = props.hasMoreInventory || props.loadingMoreInventory;
            if (integrations.length === 0) {
                rows.push({
                    kind: 'integrations_empty',
                    key: 'integrations-empty',
                    last: !hasInventoryContinuation,
                });
            } else {
                const chunkSize = 4;
                for (let offset = 0; offset < integrations.length; offset += chunkSize) {
                    const chunk = integrations.slice(offset, offset + chunkSize);
                    rows.push({
                        kind: 'integration_chunk',
                        key: `integration:${offset}:${chunk[0]!.key}`,
                        integrations: chunk,
                        first: offset === 0,
                        last: offset + chunkSize >= integrations.length && !hasInventoryContinuation,
                    });
                }
            }
            if (hasInventoryContinuation) {
                rows.push({
                    kind: 'inventory_continuation',
                    key: 'inventory-continuation',
                });
            }
            rows.push(...integrations.flatMap((integration) => (
                readExternalSessionsIntegrationDiagnostic(integration)
                    ? [{
                        kind: 'diagnostic' as const,
                        key: `diagnostic:${integration.key}`,
                        integration,
                    }]
                    : []
            )));
        }
        const autoLinkChunkSize = 4;
        for (let offset = 0; offset < (autoLinkSources?.length ?? 0); offset += autoLinkChunkSize) {
            const sources = autoLinkSources!.slice(offset, offset + autoLinkChunkSize);
            rows.push({
                kind: 'auto_link_chunk',
                key: `auto-link:${autoLinkSourceKey(sources[0]!)}`,
                sources,
                first: offset === 0,
                last: offset + autoLinkChunkSize >= autoLinkSources!.length,
            });
        }
        rows.push({ kind: 'privacy', key: 'privacy' });
        rows.push(...(props.supplementalRows ?? []).map((row) => ({
            kind: 'supplemental' as const,
            key: `supplemental:${row.key}`,
            render: row.render,
        })));
        return rows;
    }, [
        autoLinkSources,
        integrations,
        props.hasMoreInventory,
        props.loadingMoreInventory,
        props.supplementalRows,
        props.virtualized,
    ]);

    const requestMoreInventory = React.useCallback(() => {
        if (!props.hasMoreInventory || props.loadingMoreInventory) return;
        void props.onLoadMoreInventory?.();
    }, [
        props.hasMoreInventory,
        props.loadingMoreInventory,
        props.onLoadMoreInventory,
    ]);
    const handleViewableItemsChanged = React.useCallback(({
        viewableItems,
    }: Readonly<{ viewableItems: readonly ViewToken[] }>) => {
        if (viewableItems.some((token) => (
            (token.item as ExternalSessionsIntegrationVirtualizedRow | undefined)?.kind
                === 'inventory_continuation'
        ))) {
            requestMoreInventory();
        }
    }, [requestMoreInventory]);

    const renderVirtualizedRow = React.useCallback(({
        item,
    }: Readonly<{ item: ExternalSessionsIntegrationVirtualizedRow }>) => {
        if (item.kind === 'supplemental') return item.render();
        if (item.kind === 'integrations_empty') {
            return (
                <ItemGroup
                    title={t('externalSessions.settingsIntegrationsGroupTitle')}
                    footer={item.last ? t('externalSessions.settingsIntegrationsFooter') : undefined}
                    virtualizedSegment={{ first: true, last: item.last }}
                >
                    <Item
                        testID="settings-external-sessions-integrations-unavailable"
                        mode="info"
                        title={t('externalSessions.settingsIntegrationsUnavailableTitle')}
                        subtitle={t('externalSessions.settingsIntegrationsUnavailableSubtitle')}
                        icon={<Icon name="puzzle-piece" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                </ItemGroup>
            );
        }
        if (item.kind === 'inventory_continuation') {
            return (
                <ItemGroup
                    footer={t('externalSessions.settingsIntegrationsFooter')}
                    virtualizedSegment={{ first: false, last: true }}
                >
                    <Item
                        testID="settings-external-sessions-inventory-continuation"
                        mode={!props.loadingMoreInventory && props.onLoadMoreInventory
                            ? 'interactive'
                            : 'info'}
                        title={props.loadingMoreInventory
                            ? t('externalSessions.settingsIntegrationInventoryLoadingTitle')
                            : t('externalSessions.browseLoadMore')}
                        subtitle={t('externalSessions.settingsIntegrationInventoryLoadingSubtitle')}
                        icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.text.secondary} />}
                        loading={props.loadingMoreInventory}
                        showChevron={false}
                        onPress={!props.loadingMoreInventory && props.onLoadMoreInventory
                            ? requestMoreInventory
                            : undefined}
                    />
                </ItemGroup>
            );
        }
        if (item.kind === 'privacy') {
            return (
                <ItemGroup title={t('externalSessions.settingsPrivacyGroupTitle')}>
                    <Item
                        testID="settings-external-sessions-integration-privacy"
                        mode="info"
                        title={t('externalSessions.settingsPrivacyTitle')}
                        subtitle={t('externalSessions.settingsPrivacySubtitle')}
                        icon={<Icon name="lock" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                </ItemGroup>
            );
        }
        if (item.kind === 'diagnostic') {
            const diagnostic = readExternalSessionsIntegrationDiagnostic(item.integration);
            if (!diagnostic) return null;
            return (
                <PluginDiagnosticsSection
                    title={`${item.integration.agentTitle} · ${t('externalSessions.settingsIntegrationNeedsAttentionTitle')}`}
                    diagnostics={[{
                        code: diagnostic.code,
                        message: resolveDiagnosticMessage(diagnostic),
                    }]}
                    testIDPrefix={`settings-external-sessions-integration-${item.integration.key}.diagnostic`}
                />
            );
        }
        if (item.kind === 'auto_link_chunk') {
            return (
                <ItemGroup
                    title={item.first ? t('externalSessions.settingsAutoLinkGroupTitle') : undefined}
                    footer={item.last ? t('externalSessions.settingsAutoLinkGroupFooter') : undefined}
                    virtualizedSegment={{ first: item.first, last: item.last }}
                >
                    {item.sources.map((source) => {
                        const sourceKey = autoLinkSourceKey(source);
                        const pending = pendingKeys.has(`${sourceKey}:auto_link`);
                        const title = t('externalSessions.settingsAgentAutoLinkTitle', {
                            agent: props.agentTitle ?? source.agentTitle,
                        });
                        return (
                            <Item
                                key={sourceKey}
                                testID="settings-external-sessions-auto-link-source"
                                title={title}
                                subtitle={source.sourceDisplayLabel
                                    ? `${source.sourceDisplayLabel} · ${t('externalSessions.settingsAutoLinkSubtitle')}`
                                    : t('externalSessions.settingsAutoLinkSubtitle')}
                                icon={<Icon name="plus-circle" size={29} color={theme.colors.accent.blue} />}
                                loading={pending}
                                disabled={!source.canChange || pending}
                                rightElement={(
                                    <Switch
                                        testID="settings-external-sessions-auto-link-toggle"
                                        accessibilityLabel={title}
                                        accessibilityHint={t('externalSessions.settingsAutoLinkHint')}
                                        value={source.enabled}
                                        disabled={!source.canChange || pending}
                                        onValueChange={(enabled) => {
                                            void runAutoLinkChange(source, enabled);
                                        }}
                                    />
                                )}
                                rightElementOutsidePressable
                                showChevron={false}
                                onPress={() => {
                                    void runAutoLinkChange(source, !source.enabled);
                                }}
                            />
                        );
                    })}
                </ItemGroup>
            );
        }

        return (
            <ItemGroup
                title={item.first ? t('externalSessions.settingsIntegrationsGroupTitle') : undefined}
                footer={item.last ? t('externalSessions.settingsIntegrationsFooter') : undefined}
                virtualizedSegment={{ first: item.first, last: item.last }}
            >
                {item.integrations.flatMap((integration) => {
                    const actions = resolveExternalSessionsIntegrationActions(integration, operations);
                    return [(
                        <Item
                            key={`${integration.key}:status`}
                            testID={`settings-external-sessions-integration-${integration.key}`}
                            mode="info"
                            title={`${integration.agentTitle} · ${t('externalSessions.settingsIntegrationTitle')}`}
                            subtitle={integration.detail
                                ? `${resolveStatusTitle(integration.state)} · ${integration.detail}`
                                : resolveStatusTitle(integration.state)}
                            icon={<Icon name="graph" size={29} color={theme.colors.text.secondary} />}
                            showChevron={false}
                        />
                    ), ...actions.map((action) => {
                        const actionPending = pendingKeys.has(`${integration.key}:${action}`);
                        return (
                        <Item
                            key={`${integration.key}:${action}`}
                            testID={`settings-external-sessions-action-${integration.key}-${action}`}
                            subtitleTestID={`settings-external-sessions-action-row-${action}`}
                            title={resolveActionTitle(action)}
                            accessibilityLabel={`${integration.agentTitle}, ${resolveActionTitle(action)}`}
                            icon={<Icon
                                name={resolveActionIcon(action) as never}
                                size={29}
                                color={action === 'uninstall'
                                    ? theme.colors.state.danger.foreground
                                    : theme.colors.accent.blue}
                            />}
                            loading={actionPending}
                            disabled={inventoryActionsDisabled || pendingKeysRef.current.has(integration.key)}
                            destructive={action === 'uninstall'}
                            showChevron={false}
                            pressableRef={getReplacementActionRef(integration, actions, action)}
                            onPress={() => {
                                void runAction(integration, action);
                            }}
                        />
                        );
                    })];
                })}
            </ItemGroup>
        );
    }, [
        operations,
        getReplacementActionRef,
        inventoryActionsDisabled,
        pendingKeys,
        props.agentTitle,
        props.loadingMoreInventory,
        props.onLoadMoreInventory,
        requestMoreInventory,
        runAction,
        runAutoLinkChange,
        theme.colors.accent.blue,
        theme.colors.state.danger.foreground,
        theme.colors.text.secondary,
    ]);

    if (props.virtualized) {
        const inventoryAnnouncementElement = props.inventoryState
            && props.inventoryState.status !== 'idle'
            && props.inventoryState.status !== 'ready' ? (
                <View
                    testID="settings-external-sessions-inventory-announcement"
                    accessibilityRole={props.inventoryState.status === 'loading' ? 'text' : 'alert'}
                    accessibilityLiveRegion={props.inventoryState.status === 'loading' ? 'polite' : 'assertive'}
                    {...({
                        role: props.inventoryState.status === 'loading' ? 'status' : 'alert',
                        'aria-live': props.inventoryState.status === 'loading' ? 'polite' : 'assertive',
                    } as Record<string, unknown>)}
                >
                    <ItemGroup title={t('externalSessions.settingsIntegrationsGroupTitle')}>
                        <Item
                            testID="settings-external-sessions-inventory-status"
                            mode={props.inventoryState.status !== 'loading' && props.onRetryInventory
                                ? 'interactive'
                                : 'info'}
                            title={inventoryTitle ?? t('externalSessions.settingsIntegrationInventoryErrorTitle')}
                            subtitle={inventorySubtitle ?? t('externalSessions.settingsIntegrationInventoryErrorSubtitle')}
                            icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.text.secondary} />}
                            loading={props.inventoryState.status === 'loading'}
                            showChevron={false}
                            onPress={props.inventoryState.status !== 'loading' && props.onRetryInventory
                                ? () => void props.onRetryInventory?.()
                                : undefined}
                        />
                    </ItemGroup>
                </View>
            ) : null;
        return (
            <View
                ref={sectionFocusFallbackRef}
                testID="settings-external-sessions-focus-fallback"
                style={{ flex: 1 }}
                {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
            >
                <VirtualizedList
                    testID="settings-external-sessions-virtualized-list"
                    data={virtualizedRows}
                    keyExtractor={(item) => item.key}
                    renderItem={renderVirtualizedRow}
                    style={{
                        flex: 1,
                        backgroundColor: theme.colors.background.canvas,
                        ...(Platform.OS === 'web' ? { minHeight: 0 } : {}),
                    }}
                    contentContainerStyle={{ paddingBottom: Platform.OS === 'ios' ? 34 : 16 }}
                    ListHeaderComponent={(
                        <>
                            {props.virtualizedHeader}
                            {inventoryAnnouncementElement}
                        </>
                    )}
                    backendPreference="auto"
                    initialNumToRender={6}
                    maxToRenderPerBatch={4}
                    windowSize={7}
                    estimatedItemSize={120}
                    maintainVisibleContentPosition
                    onEndReached={requestMoreInventory}
                    onEndReachedThreshold={0.5}
                    onViewableItemsChanged={handleViewableItemsChanged}
                />
            </View>
        );
    }

    return (
        <View
            ref={sectionFocusFallbackRef}
            testID="settings-external-sessions-focus-fallback"
            {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
        >
            {props.inventoryState
                && props.inventoryState.status !== 'idle'
                && props.inventoryState.status !== 'ready' ? (
                    <View
                        testID="settings-external-sessions-inventory-announcement"
                        accessibilityRole={props.inventoryState.status === 'loading' ? 'text' : 'alert'}
                        accessibilityLiveRegion={props.inventoryState.status === 'loading' ? 'polite' : 'assertive'}
                        {...({
                            role: props.inventoryState.status === 'loading' ? 'status' : 'alert',
                            'aria-live': props.inventoryState.status === 'loading' ? 'polite' : 'assertive',
                        } as Record<string, unknown>)}
                    >
                        <ItemGroup title={t('externalSessions.settingsIntegrationsGroupTitle')}>
                            <Item
                                testID="settings-external-sessions-inventory-status"
                                mode={
                                    props.inventoryState.status !== 'loading'
                                        && props.onRetryInventory
                                        ? 'interactive'
                                        : 'info'
                                }
                                title={inventoryTitle ?? t('externalSessions.settingsIntegrationInventoryErrorTitle')}
                                subtitle={inventorySubtitle ?? t('externalSessions.settingsIntegrationInventoryErrorSubtitle')}
                                icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.text.secondary} />}
                                loading={props.inventoryState.status === 'loading'}
                                showChevron={false}
                                onPress={
                                    props.inventoryState.status !== 'loading' && props.onRetryInventory
                                        ? () => {
                                            void props.onRetryInventory?.();
                                        }
                                        : undefined
                                }
                            />
                        </ItemGroup>
                    </View>
                ) : null}
            {integrations === null ? null : (
                <ItemGroup
                    title={t('externalSessions.settingsIntegrationsGroupTitle')}
                    footer={t('externalSessions.settingsIntegrationsFooter')}
                >
                    {integrations.length === 0 ? (
                        <Item
                            testID="settings-external-sessions-integrations-unavailable"
                            mode="info"
                            title={t('externalSessions.settingsIntegrationsUnavailableTitle')}
                            subtitle={t('externalSessions.settingsIntegrationsUnavailableSubtitle')}
                            icon={<Icon name="puzzle-piece" size={29} color={theme.colors.text.secondary} />}
                            showChevron={false}
                        />
                    ) : integrations.map((integration) => {
                        const actions = resolveExternalSessionsIntegrationActions(
                            integration,
                            operations,
                        );
                        return (
                            <React.Fragment key={integration.key}>
                                <Item
                                    testID={`settings-external-sessions-integration-${integration.key}`}
                                    mode="info"
                                    title={`${integration.agentTitle} · ${t('externalSessions.settingsIntegrationTitle')}`}
                                    subtitle={integration.detail
                                        ? `${resolveStatusTitle(integration.state)} · ${integration.detail}`
                                        : resolveStatusTitle(integration.state)}
                                    icon={<Icon name="graph" size={29} color={theme.colors.text.secondary} />}
                                    showChevron={false}
                                />
                                {actions.map((resolvedAction) => {
                                    const action = resolvedAction;
                                    const actionPending = pendingKeys.has(`${integration.key}:${action}`);
                                    return (
                                        <Item
                                            key={action}
                                            testID={`settings-external-sessions-action-${integration.key}-${action}`}
                                            subtitleTestID={`settings-external-sessions-action-row-${action}`}
                                            title={resolveActionTitle(action)}
                                            accessibilityLabel={`${integration.agentTitle}, ${resolveActionTitle(action)}`}
                                            icon={(
                                                <Icon
                                                    name={resolveActionIcon(action) as never}
                                                    size={29}
                                                    color={action === 'uninstall'
                                                        ? theme.colors.state.danger.foreground
                                                        : theme.colors.accent.blue}
                                                />
                                            )}
                                            loading={actionPending}
                                            disabled={inventoryActionsDisabled || pendingKeysRef.current.has(integration.key)}
                                            destructive={action === 'uninstall'}
                                            showChevron={false}
                                            pressableRef={getReplacementActionRef(
                                                integration,
                                                actions,
                                                action,
                                            )}
                                            onPress={() => {
                                                void runAction(integration, action);
                                            }}
                                        />
                                    );
                                })}
                            </React.Fragment>
                        );
                    })}
                    {props.hasMoreInventory || props.loadingMoreInventory ? (
                        <Item
                            testID="settings-external-sessions-inventory-continuation"
                            mode={!props.loadingMoreInventory && props.onLoadMoreInventory
                                ? 'interactive'
                                : 'info'}
                            title={props.loadingMoreInventory
                                ? t('externalSessions.settingsIntegrationInventoryLoadingTitle')
                                : t('externalSessions.browseLoadMore')}
                            subtitle={t('externalSessions.settingsIntegrationInventoryLoadingSubtitle')}
                            icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.text.secondary} />}
                            loading={props.loadingMoreInventory}
                            showChevron={false}
                            onPress={!props.loadingMoreInventory && props.onLoadMoreInventory
                                ? () => void props.onLoadMoreInventory?.()
                                : undefined}
                        />
                    ) : null}
                </ItemGroup>
            )}
            {integrations?.map((integration) => {
                const diagnostic = readExternalSessionsIntegrationDiagnostic(integration);
                return diagnostic ? (
                    <PluginDiagnosticsSection
                        key={integration.key}
                        title={`${integration.agentTitle} · ${t('externalSessions.settingsIntegrationNeedsAttentionTitle')}`}
                        diagnostics={[{
                            code: diagnostic.code,
                            message: resolveDiagnosticMessage(diagnostic),
                        }]}
                        testIDPrefix={`settings-external-sessions-integration-${integration.key}.diagnostic`}
                    />
                ) : null;
            })}

            {autoLinkSources && autoLinkSources.length > 0 ? (
                <ItemGroup
                    title={t('externalSessions.settingsAutoLinkGroupTitle')}
                    footer={t('externalSessions.settingsAutoLinkGroupFooter')}
                >
                    {autoLinkSources.map((source) => {
                        const sourceKey = autoLinkSourceKey(source);
                        const pendingKey = `${sourceKey}:auto_link`;
                        const pending = pendingKeys.has(pendingKey);
                        const title = t('externalSessions.settingsAgentAutoLinkTitle', {
                            agent: props.agentTitle ?? source.agentTitle,
                        });
                        return (
                            <Item
                                key={sourceKey}
                                testID="settings-external-sessions-auto-link-source"
                                title={title}
                                subtitle={source.sourceDisplayLabel
                                    ? `${source.sourceDisplayLabel} · ${t('externalSessions.settingsAutoLinkSubtitle')}`
                                    : t('externalSessions.settingsAutoLinkSubtitle')}
                                icon={<Icon name="plus-circle" size={29} color={theme.colors.accent.blue} />}
                                loading={pending}
                                disabled={!source.canChange || pending}
                                rightElement={(
                                    <Switch
                                        testID="settings-external-sessions-auto-link-toggle"
                                        accessibilityLabel={title}
                                        accessibilityHint={t('externalSessions.settingsAutoLinkHint')}
                                        value={source.enabled}
                                        disabled={!source.canChange || pending}
                                        onValueChange={(enabled) => {
                                            void runAutoLinkChange(source, enabled);
                                        }}
                                    />
                                )}
                                rightElementOutsidePressable
                                showChevron={false}
                                onPress={() => {
                                    void runAutoLinkChange(source, !source.enabled);
                                }}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('externalSessions.settingsPrivacyGroupTitle')}>
                <Item
                    testID="settings-external-sessions-integration-privacy"
                    mode="info"
                    title={t('externalSessions.settingsPrivacyTitle')}
                    subtitle={t('externalSessions.settingsPrivacySubtitle')}
                    icon={<Icon name="lock" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            </ItemGroup>
        </View>
    );
});
