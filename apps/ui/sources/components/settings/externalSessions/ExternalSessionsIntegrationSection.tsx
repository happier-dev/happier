import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PluginDiagnosticsSection } from '@/components/settings/plugins/diagnostics/PluginDiagnosticsSection';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { PluginDiagnosticDataV1 } from '@happier-dev/protocol';
import type { PluginSessionHookInstallPreviewV1 } from '@happier-dev/protocol';

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

function autoLinkSourceKey(source: ExternalSessionsAutoLinkSourceDescriptor): string {
    return [
        source.machineId,
        source.agent.pluginId,
        source.agent.localId,
        source.sourcePolicyId,
    ].join('\u0000');
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
    const [pendingKeys, setPendingKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const operations = !props.inventoryState
        || isExternalSessionsIntegrationInventoryActionable(props.inventoryState.status)
        ? props.operations
        : null;

    const runAction = React.useCallback(async (
        integration: ExternalSessionsIntegrationDescriptor,
        action: ExternalSessionsIntegrationAction,
    ) => {
        const pendingKey = `${integration.key}:${action}`;
        if (!operations || pendingKeysRef.current.has(integration.key)) return;

        pendingKeysRef.current.add(integration.key);
        setPendingKeys((current) => new Set(current).add(pendingKey));
        try {
            if (action === 'review_install') {
                await operations.reviewAndInstall(
                    integration,
                    async (preview) => await Modal.confirm(
                        t('externalSessions.settingsIntegrationReviewTitle', { agent: integration.agentTitle }),
                        t('externalSessions.settingsIntegrationReviewBody', {
                            entries: formatInstallPreview(preview),
                        }),
                        {
                            confirmText: t('externalSessions.settingsIntegrationActionInstall'),
                        },
                    ),
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
            await resolveActionOperation(action, operations)(integration);
        } catch {
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
    }, [operations]);

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
            await source.setEnabled(enabled);
        } catch {
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
    }, []);

    return (
        <>
            {props.inventoryState
                && props.inventoryState.status !== 'idle'
                && props.inventoryState.status !== 'ready' ? (
                    <ItemGroup title={t('externalSessions.settingsIntegrationsGroupTitle')}>
                        <Item
                            testID="settings-external-sessions-inventory-status"
                            mode={
                                props.inventoryState.status !== 'loading'
                                    && props.onRetryInventory
                                    ? 'interactive'
                                    : 'info'
                            }
                            title={props.inventoryState.status === 'loading'
                                ? t('externalSessions.settingsIntegrationInventoryLoadingTitle')
                                : props.inventoryState.status === 'partial'
                                    ? t('externalSessions.settingsIntegrationInventoryPartialTitle')
                                    : t('externalSessions.settingsIntegrationInventoryErrorTitle')}
                            subtitle={[
                                props.inventoryState.status === 'loading'
                                    ? t('externalSessions.settingsIntegrationInventoryLoadingSubtitle')
                                    : props.inventoryState.status === 'partial'
                                        ? t('externalSessions.settingsIntegrationInventoryPartialSubtitle')
                                        : t('externalSessions.settingsIntegrationInventoryErrorSubtitle'),
                                props.inventoryState.diagnosticCodes.join(', '),
                            ].filter(Boolean).join(' · ')}
                            icon={<SafeIonicons name="refresh-outline" size={29} color={theme.colors.text.secondary} />}
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
                            icon={<SafeIonicons name="extension-puzzle-outline" size={29} color={theme.colors.text.secondary} />}
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
                                    icon={<SafeIonicons name="git-network-outline" size={29} color={theme.colors.text.secondary} />}
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
                                                <SafeIonicons
                                                    name={resolveActionIcon(action) as never}
                                                    size={29}
                                                    color={action === 'uninstall'
                                                        ? theme.colors.state.danger.foreground
                                                        : theme.colors.accent.blue}
                                                />
                                            )}
                                            loading={actionPending}
                                            disabled={pendingKeysRef.current.has(integration.key)}
                                            destructive={action === 'uninstall'}
                                            showChevron={false}
                                            onPress={() => {
                                                void runAction(integration, action);
                                            }}
                                        />
                                    );
                                })}
                            </React.Fragment>
                        );
                    })}
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
                                icon={<SafeIonicons name="add-circle-outline" size={29} color={theme.colors.accent.blue} />}
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
                    icon={<SafeIonicons name="lock-closed-outline" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            </ItemGroup>
        </>
    );
});
