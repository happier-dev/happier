import * as React from 'react';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { presentProviderCompatibilityReasons } from '@/providers/connection/compatibilityReasonPresentation';
import type { ProviderModelPickerVisibility } from '@/providers/hooks/useProviderModelPickerVisibility';
import { t } from '@/text';

type CompatibilitySummary = DaemonProviderConnectionViewV1['compatibility'][number];
type Endpoint = DaemonProviderConnectionViewV1['endpoints'][number];

/** "Show in model picker" for one connection: the same Account-wide switch every agent reads. */
export function ProviderPickerVisibilityRow(props: Readonly<{
    providerName: string;
    visibility: ProviderModelPickerVisibility;
    /** Why this kind of source starts as it does, when the page knows more than the default reason. */
    description?: string;
}>): React.ReactElement {
    const { visibility } = props;
    const title = t('settingsProvidersCollection.showInPickerTitle');
    return (
        <Item
            testID="provider-connection-picker-visibility"
            title={title}
            subtitle={props.description ?? (visibility.defaultReason === 'direct'
                ? t('settingsProvidersCollection.showInPickerDirect', { provider: props.providerName })
                : visibility.defaultReason === 'manyModels'
                    ? t('settingsProvidersCollection.showInPickerManyModels')
                    : t('settingsProvidersCollection.showInPickerLocal'))}
            subtitleLines={0}
            showChevron={false}
            rightElement={visibility.busy ? <ActivitySpinner size="small" /> : (
                <Switch accessibilityLabel={title} value={visibility.shown} onValueChange={visibility.setShown} />
            )}
            rightElementOutsidePressable
        />
    );
}

export function ProviderCompatibilitySection(props: Readonly<{
    summaries: readonly CompatibilitySummary[];
}>): React.ReactElement | null {
    if (props.summaries.length === 0) return null;
    return (
        <ItemGroup title={t('settingsProviders.compatibility.title')} description={t('settingsProviders.compatibility.footer')}>
            {props.summaries.map((summary) => (
                <Item
                    key={summary.agentTargetKey}
                    mode="info"
                    title={summary.agentName}
                    subtitle={[
                        summary.status === 'verified'
                            ? t('settingsProviders.compatibility.verifiedDescription')
                            : summary.status === 'experimental'
                                ? t('settingsProviders.compatibility.experimentalDescription')
                                : t('settingsProviders.compatibility.incompatibleDescription'),
                        ...presentProviderCompatibilityReasons(summary.reasons).map((reason) => t(reason.descriptionKey)),
                    ].join(' · ')}
                    rightElement={<StatusPill
                        chrome="plain"
                        variant={summary.status === 'verified' ? 'success' : summary.status === 'experimental' ? 'warning' : 'neutral'}
                        label={summary.status === 'verified'
                            ? t('settingsProviders.compatibility.verified')
                            : summary.status === 'experimental'
                                ? t('settingsProviders.compatibility.experimental')
                                : t('settingsProviders.compatibility.incompatible')}
                    />}
                    rightElementOutsidePressable
                />
            ))}
        </ItemGroup>
    );
}

export function ProviderEndpointOverridesSection(props: Readonly<{
    endpoints: readonly Endpoint[];
    onSetOverride: (input: Readonly<{
        endpointTemplateId: string;
        currentUrl: string;
        scope: 'account' | 'machine';
        reset?: boolean;
    }>) => void;
}>): React.ReactElement | null {
    if (props.endpoints.length === 0) return null;
    return (
        <ItemGroup title={t('settingsProviders.detail.advancedTitle')} description={t('settingsProvidersCollection.overridesDescription')}>
            {props.endpoints.flatMap((endpoint) => {
                const accountBaseUrl = endpoint.accountOverrideBaseUrl
                    ?? endpoint.defaultBaseUrl
                    ?? (endpoint.effectiveSource !== 'machineOverride' ? endpoint.baseUrl : null);
                const machineBaseUrl = endpoint.machineOverrideBaseUrl;
                const rows = [
                    <Item
                        key={`${endpoint.endpointTemplateId}:effective`}
                        mode="info"
                        title={endpoint.protocol}
                        subtitle={endpoint.baseUrl}
                        detail={endpoint.effectiveSource === 'machineOverride'
                            ? t('settingsProviders.detail.endpointMachine')
                            : t('settingsProviders.detail.endpointDefault')}
                    />,
                    <FieldValueItem
                        key={`${endpoint.endpointTemplateId}:account`}
                        fieldTestID={`provider-connection-endpoint.${endpoint.endpointTemplateId}.account`}
                        title={t('settingsProviders.detail.endpointDefault')}
                        accessibilityLabel={`${endpoint.protocol}, ${t('settingsProviders.detail.endpointDefault')}`}
                        subtitle={accountBaseUrl ?? t('settingsProviders.detail.resetDefaultEndpoint')}
                        value={accountBaseUrl ?? endpoint.baseUrl}
                        onCommit={(baseUrl) => props.onSetOverride({
                            endpointTemplateId: endpoint.endpointTemplateId,
                            currentUrl: baseUrl,
                            scope: 'account',
                        })}
                    />,
                ];
                if (endpoint.accountOverrideBaseUrl !== null || endpoint.effectiveSource === 'accountOverride') {
                    rows.push(<Item
                        key={`${endpoint.endpointTemplateId}:reset-account`}
                        title={t('settingsProviders.detail.resetEndpoint')}
                        accessibilityLabel={`${endpoint.protocol}, ${t('settingsProviders.detail.endpointDefault')}, ${t('settingsProviders.detail.resetEndpoint')}`}
                        subtitle={t('settingsProviders.detail.resetDefaultEndpoint')}
                        onPress={() => props.onSetOverride({
                            endpointTemplateId: endpoint.endpointTemplateId,
                            currentUrl: accountBaseUrl ?? endpoint.baseUrl,
                            scope: 'account',
                            reset: true,
                        })}
                    />);
                }
                rows.push(<FieldValueItem
                    key={`${endpoint.endpointTemplateId}:machine`}
                    fieldTestID={`provider-connection-endpoint.${endpoint.endpointTemplateId}.machine`}
                    title={t('settingsProviders.detail.endpointMachine')}
                    accessibilityLabel={`${endpoint.protocol}, ${t('settingsProviders.detail.endpointMachine')}`}
                    subtitle={machineBaseUrl ?? t('settingsProviders.detail.endpointMachineDescription')}
                    value={machineBaseUrl ?? accountBaseUrl ?? endpoint.baseUrl}
                    onCommit={(baseUrl) => props.onSetOverride({
                        endpointTemplateId: endpoint.endpointTemplateId,
                        currentUrl: baseUrl,
                        scope: 'machine',
                    })}
                />);
                if (machineBaseUrl !== null || endpoint.effectiveSource === 'machineOverride') {
                    rows.push(<Item
                        key={`${endpoint.endpointTemplateId}:reset-machine`}
                        title={t('settingsProviders.detail.resetEndpoint')}
                        accessibilityLabel={`${endpoint.protocol}, ${t('settingsProviders.detail.endpointMachine')}, ${t('settingsProviders.detail.resetEndpoint')}`}
                        subtitle={t('settingsProviders.detail.resetMachineEndpoint')}
                        onPress={() => props.onSetOverride({
                            endpointTemplateId: endpoint.endpointTemplateId,
                            currentUrl: machineBaseUrl ?? endpoint.baseUrl,
                            scope: 'machine',
                            reset: true,
                        })}
                    />);
                }
                return rows;
            })}
        </ItemGroup>
    );
}
