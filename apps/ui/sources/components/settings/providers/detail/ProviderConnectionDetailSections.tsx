import * as React from 'react';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { PROVIDER_DETAIL_SETTINGS } from '../providersSettings';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { presentProviderCompatibilityReasons } from '@/providers/connection/compatibilityReasonPresentation';
import { endpointProtocolLabel } from '@/providers/connection/endpointProtocolLabel';
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
    /** Injected by the enclosing `ItemGroup`, so the section's last row draws no divider. */
    showDivider?: boolean;
}>): React.ReactElement {
    const { visibility } = props;
    const title = t('settingsProvidersCollection.showInPickerTitle');
    return (
        <SettingAnchor setting={PROVIDER_DETAIL_SETTINGS.settings.visibility} showDivider={props.showDivider}><Item
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
        /></SettingAnchor>
    );
}

const COMPATIBILITY_ORDER: Readonly<Record<CompatibilitySummary['status'], number>> = {
    verified: 0, experimental: 1, incompatible: 2,
};

/** What a row adds to its pill: its reasons, else the consequence of an experimental pairing. */
function compatibilityDetail(summary: CompatibilitySummary): string | undefined {
    const reasons = presentProviderCompatibilityReasons(summary.reasons).map((reason) => t(reason.descriptionKey));
    if (reasons.length > 0) return reasons.join(' · ');
    return summary.status === 'experimental' ? t('settingsProviders.compatibility.experimentalDescription') : undefined;
}

/**
 * Which agents can use this connection: the ones that can, each with its pill, then the ones that
 * cannot folded into one quiet row that names them and opens to say why.
 */
export function ProviderCompatibilitySection(props: Readonly<{
    summaries: readonly CompatibilitySummary[];
}>): React.ReactElement | null {
    if (props.summaries.length === 0) return null;
    const usable = props.summaries
        .filter((summary) => summary.status !== 'incompatible')
        .sort((a, b) => COMPATIBILITY_ORDER[a.status] - COMPATIBILITY_ORDER[b.status]);
    const incompatible = props.summaries.filter((summary) => summary.status === 'incompatible');
    return (
        <ItemGroup title={t('settingsProviders.compatibility.title')} description={t('settingsProviders.compatibility.footer')}>
            {usable.map((summary) => (
                <Item
                    key={summary.agentTargetKey}
                    mode="info"
                    title={summary.agentName}
                    subtitle={compatibilityDetail(summary)}
                    rightElement={<StatusPill
                        chrome="plain"
                        variant={summary.status === 'verified' ? 'success' : 'warning'}
                        label={summary.status === 'verified'
                            ? t('settingsProviders.compatibility.verified')
                            : t('settingsProviders.compatibility.experimental')}
                    />}
                    rightElementOutsidePressable
                />
            ))}
            {incompatible.length > 0 ? (
                <CountedDisclosureItem
                    testID="provider-connection-compatibility-incompatible"
                    title={t('settingsProviders.compatibility.incompatible')}
                    count={incompatible.length}
                    subtitle={incompatible.map((summary) => summary.agentName).join(', ')}
                >
                    {incompatible.map((summary) => (
                        <Item
                            key={summary.agentTargetKey}
                            mode="info"
                            title={summary.agentName}
                            subtitle={compatibilityDetail(summary)}
                            subtitleLines={0}
                        />
                    ))}
                </CountedDisclosureItem>
            ) : null}
        </ItemGroup>
    );
}

/**
 * Where each protocol's requests go, inside the detail's Advanced disclosure: one row per protocol,
 * named for people (never its wire id), holding its address once. A computer's own address is offered
 * only while a computer is chosen; without one there is nothing it could apply to.
 */
export function ProviderEndpointOverridesSection(props: Readonly<{
    endpoints: readonly Endpoint[];
    /** A computer is chosen, so its own address can be read and changed. */
    machineSelected: boolean;
    onSetOverride: (input: Readonly<{
        endpointTemplateId: string;
        currentUrl: string;
        scope: 'account' | 'machine';
        reset?: boolean;
    }>) => void;
}>): React.ReactElement | null {
    if (props.endpoints.length === 0) return null;
    return (
        <ItemGroup title={t('settingsProvidersCollection.endpointsTitle')} description={t('settingsProvidersCollection.overridesDescription')}>
            {props.endpoints.flatMap((endpoint) => {
                const label = endpointProtocolLabel(endpoint.protocol);
                const accountBaseUrl = endpoint.accountOverrideBaseUrl
                    ?? endpoint.defaultBaseUrl
                    ?? (endpoint.effectiveSource !== 'machineOverride' ? endpoint.baseUrl : null);
                const machineBaseUrl = endpoint.machineOverrideBaseUrl;
                const rows = [
                    <FieldValueItem
                        key={`${endpoint.endpointTemplateId}:account`}
                        fieldTestID={`provider-connection-endpoint.${endpoint.endpointTemplateId}.account`}
                        title={label}
                        accessibilityLabel={`${label}, ${t('settingsProviders.detail.endpointDefault')}`}
                        value={accountBaseUrl ?? ''}
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
                        accessibilityLabel={`${label}, ${t('settingsProviders.detail.endpointDefault')}, ${t('settingsProviders.detail.resetEndpoint')}`}
                        subtitle={t('settingsProviders.detail.resetDefaultEndpoint')}
                        onPress={() => props.onSetOverride({
                            endpointTemplateId: endpoint.endpointTemplateId,
                            currentUrl: accountBaseUrl ?? '',
                            scope: 'account',
                            reset: true,
                        })}
                    />);
                }
                if (!props.machineSelected) return rows;
                rows.push(<FieldValueItem
                    key={`${endpoint.endpointTemplateId}:machine`}
                    fieldTestID={`provider-connection-endpoint.${endpoint.endpointTemplateId}.machine`}
                    title={t('settingsProviders.detail.endpointMachine')}
                    accessibilityLabel={`${label}, ${t('settingsProviders.detail.endpointMachine')}`}
                    subtitle={machineBaseUrl === null ? t('settingsProviders.detail.endpointMachineDescription') : undefined}
                    value={machineBaseUrl ?? accountBaseUrl ?? endpoint.baseUrl ?? ''}
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
                        accessibilityLabel={`${label}, ${t('settingsProviders.detail.endpointMachine')}, ${t('settingsProviders.detail.resetEndpoint')}`}
                        subtitle={t('settingsProviders.detail.resetMachineEndpoint')}
                        onPress={() => props.onSetOverride({
                            endpointTemplateId: endpoint.endpointTemplateId,
                            currentUrl: machineBaseUrl ?? endpoint.baseUrl ?? '',
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
