import * as React from 'react';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { presentProviderCompatibilityReasons } from '@/providers/connection/compatibilityReasonPresentation';
import { t } from '@/text';

type CompatibilitySummary = DaemonProviderConnectionViewV1['compatibility'][number];
type Endpoint = DaemonProviderConnectionViewV1['endpoints'][number];

export function ProviderCompatibilitySection(props: Readonly<{
    summaries: readonly CompatibilitySummary[];
}>): React.ReactElement | null {
    if (props.summaries.length === 0) return null;
    return (
        <ItemGroup title={t('settingsProviders.compatibility.title')} footer={t('settingsProviders.compatibility.footer')}>
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
        <ItemGroup title={t('settingsProviders.detail.advancedTitle')} footer={t('settingsProviders.detail.endpointPrompt')}>
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
                    <Item
                        key={`${endpoint.endpointTemplateId}:account`}
                        title={t('settingsProviders.detail.endpointDefault')}
                        accessibilityLabel={`${endpoint.protocol}, ${t('settingsProviders.detail.endpointDefault')}`}
                        subtitle={accountBaseUrl ?? t('settingsProviders.detail.resetDefaultEndpoint')}
                        onPress={() => props.onSetOverride({
                            endpointTemplateId: endpoint.endpointTemplateId,
                            currentUrl: accountBaseUrl ?? endpoint.baseUrl,
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
                rows.push(<Item
                    key={`${endpoint.endpointTemplateId}:machine`}
                    title={t('settingsProviders.detail.endpointMachine')}
                    accessibilityLabel={`${endpoint.protocol}, ${t('settingsProviders.detail.endpointMachine')}`}
                    subtitle={machineBaseUrl ?? t('settingsProviders.detail.endpointMachineDescription')}
                    onPress={() => props.onSetOverride({
                        endpointTemplateId: endpoint.endpointTemplateId,
                        currentUrl: machineBaseUrl ?? accountBaseUrl ?? endpoint.baseUrl,
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
