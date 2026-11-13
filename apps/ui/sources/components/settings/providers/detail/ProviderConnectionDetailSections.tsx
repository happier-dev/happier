import * as React from 'react';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { PROVIDER_DETAIL_SETTINGS } from '../providersSettings';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { EndpointHeadersEditor } from '@happier-dev/plugin-ui';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { endpointHeadersCopy } from '../endpointHeadersCopy';
import { Switch } from '@/components/ui/forms/Switch';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { presentProviderCompatibilityReasons, type ProviderCompatibilityReasonDescriptionKey } from '@/providers/connection/compatibilityReasonPresentation';
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

/**
 * What a row adds to its pill: the reasons that set it apart, else the consequence of an experimental pairing.
 * A reason the section already states (`said`) is not repeated; a row left with nothing new says nothing.
 */
function compatibilityDetail(summary: CompatibilitySummary, said: ReadonlySet<ProviderCompatibilityReasonDescriptionKey> = new Set()): string | undefined {
    const all = presentProviderCompatibilityReasons(summary.reasons);
    const reasons = all.filter((reason) => !said.has(reason.descriptionKey)).map((reason) => t(reason.descriptionKey));
    if (reasons.length > 0) return reasons.join(' · ');
    if (all.length > 0) return undefined;
    return summary.status === 'experimental' ? t('settingsProviders.compatibility.experimentalDescription') : undefined;
}

/** The reasons every usable agent shares: said once in the section description instead of under each agent. */
function sharedCompatibilityReasons(summaries: readonly CompatibilitySummary[]): readonly ProviderCompatibilityReasonDescriptionKey[] {
    if (summaries.length < 2) return [];
    const [first, ...rest] = summaries.map((summary) =>
        new Set(presentProviderCompatibilityReasons(summary.reasons).map((reason) => reason.descriptionKey)));
    return [...(first ?? [])].filter((key) => rest.every((keys) => keys.has(key)));
}

/**
 * Which agents can use this connection: the ones that can, each with its pill, then the ones that
 * cannot folded into one quiet row that names them and opens to say why.
 */
export function ProviderCompatibilitySection(props: Readonly<{
    summaries: readonly CompatibilitySummary[];
    onReview?: (agentTargetKey: string) => void;
}>): React.ReactElement | null {
    if (props.summaries.length === 0) return null;
    const usable = props.summaries
        .filter((summary) => summary.status !== 'incompatible')
        .sort((a, b) => COMPATIBILITY_ORDER[a.status] - COMPATIBILITY_ORDER[b.status]);
    const incompatible = props.summaries.filter((summary) => summary.status === 'incompatible');
    const shared = sharedCompatibilityReasons(usable);
    const said = new Set(shared);
    return (
        <ItemGroup
            title={t('settingsProviders.compatibility.title')}
            description={[t('settingsProviders.compatibility.footer'), ...shared.map((key) => t(key))].join(' ')}
        >
            {usable.map((summary) => (
                <Item
                    key={summary.agentTargetKey}
                    mode={summary.status === 'experimental' && props.onReview ? undefined : 'info'}
                    title={summary.agentName}
                    subtitle={compatibilityDetail(summary, said)}
                    onPress={summary.status === 'experimental' && props.onReview
                        ? () => props.onReview?.(summary.agentTargetKey) : undefined}
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
                    // One quiet line, its count alone, so the agents that can use it lead; names open on demand.
                    count={incompatible.length}
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
    /** A header-only change at one layer; it never carries (or pins) an address. */
    onSetHeaders: (input: Readonly<{
        endpointTemplateId: string;
        scope: 'account' | 'machine';
        publicHeaders: Record<string, string> | null;
    }>) => void;
    /** Resolves the contributing plugin's localized header hints. */
    localizeText: (value: unknown) => string;
}>): React.ReactElement | null {
    if (props.endpoints.length === 0) return null;
    // Each endpoint is its own sheet: an agent uses only the endpoint it speaks, so an unset one
    // blocks only those agents and never reads as the connection's state. The header editor is the public
    // plugin-ui one, so the sheets sit in core's plugin presentation scope.
    return (
        <CorePluginUiPresentationScope>
            {props.endpoints.map((endpoint, index) => {
                const label = endpointProtocolLabel(endpoint.protocol);
                const accountBaseUrl = endpoint.accountOverrideBaseUrl
                    ?? endpoint.defaultBaseUrl
                    ?? (endpoint.effectiveSource !== 'machineOverride' ? endpoint.baseUrl : null);
                const machineBaseUrl = endpoint.machineOverrideBaseUrl;
                const hints = endpoint.publicHeaderHints
                    ? Object.fromEntries(Object.entries(endpoint.publicHeaderHints).map(([name, hint]) => [name, props.localizeText(hint)]))
                    : undefined;
                const accountHeaders = endpoint.accountOverridePublicHeaders;
                // The every-machine field speaks for the Account and provider layers only: an address set for the
                // chosen machine alone is that machine's, and no other machine inherits it.
                const unset = (accountBaseUrl ?? '') === '';
                const rows = [
                    <FieldValueItem
                        key={`${endpoint.endpointTemplateId}:account`}
                        fieldTestID={`provider-connection-endpoint.${endpoint.endpointTemplateId}.account`}
                        title={t('settingsProviders.detail.endpointDefault')}
                        accessibilityLabel={`${label}, ${t('settingsProviders.detail.endpointDefault')}`}
                        subtitle={unset && endpoint.requiresEndpointOverride ? t('settingsProvidersCollection.endpointNotSet') : undefined}
                        subtitleLines={0}
                        value={accountBaseUrl ?? ''}
                        placeholder={t('settingsProviders.authoring.baseUrlPlaceholder')}
                        monospace
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
                        subtitle={t(endpoint.defaultBaseUrl === null
                            ? 'settingsProviders.detail.clearEndpoint'
                            : 'settingsProviders.detail.resetDefaultEndpoint')}
                        // An operation, not a destination: no chevron (as the headers' own reset row).
                        showChevron={false}
                        onPress={() => props.onSetOverride({
                            endpointTemplateId: endpoint.endpointTemplateId,
                            currentUrl: accountBaseUrl ?? '',
                            scope: 'account',
                            reset: true,
                        })}
                    />);
                }
                rows.push(<EndpointHeadersEditor
                    key={`${endpoint.endpointTemplateId}:account-headers`}
                    testID={`provider-connection-endpoint.${endpoint.endpointTemplateId}.account`}
                    layer="account"
                    values={accountHeaders}
                    inherited={endpoint.defaultPublicHeaders}
                    copy={endpointHeadersCopy('account')}
                    required={endpoint.requiredPublicHeaders}
                    hints={hints}
                    onChange={(publicHeaders) => props.onSetHeaders({
                        endpointTemplateId: endpoint.endpointTemplateId, scope: 'account', publicHeaders,
                    })}
                />);
                if (props.machineSelected) {
                    rows.push(<FieldValueItem
                        key={`${endpoint.endpointTemplateId}:machine`}
                        fieldTestID={`provider-connection-endpoint.${endpoint.endpointTemplateId}.machine`}
                        title={t('settingsProviders.detail.endpointMachine')}
                        accessibilityLabel={`${label}, ${t('settingsProviders.detail.endpointMachine')}`}
                        subtitle={machineBaseUrl === null ? t('settingsProviders.detail.endpointMachineDescription') : undefined}
                        value={machineBaseUrl ?? accountBaseUrl ?? endpoint.baseUrl ?? ''}
                        placeholder={t('settingsProviders.authoring.baseUrlPlaceholder')}
                        monospace
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
                            subtitle={t(accountBaseUrl === null
                                ? 'settingsProviders.detail.clearEndpoint'
                                : 'settingsProviders.detail.resetMachineEndpoint')}
                            showChevron={false}
                            onPress={() => props.onSetOverride({
                                endpointTemplateId: endpoint.endpointTemplateId,
                                currentUrl: machineBaseUrl ?? endpoint.baseUrl ?? '',
                                scope: 'machine',
                                reset: true,
                            })}
                        />);
                    }
                    rows.push(<EndpointHeadersEditor
                        key={`${endpoint.endpointTemplateId}:machine-headers`}
                        testID={`provider-connection-endpoint.${endpoint.endpointTemplateId}.machine`}
                        layer="machine"
                        values={endpoint.machineOverridePublicHeaders}
                        inherited={{ ...endpoint.defaultPublicHeaders, ...accountHeaders }}
                        copy={endpointHeadersCopy('machine')}
                        required={endpoint.requiredPublicHeaders}
                        hints={hints}
                        onChange={(publicHeaders) => props.onSetHeaders({
                            endpointTemplateId: endpoint.endpointTemplateId, scope: 'machine', publicHeaders,
                        })}
                    />);
                }
                return (
                    <ItemGroup
                        key={endpoint.endpointTemplateId}
                        testID={`provider-connection-endpoint.${endpoint.endpointTemplateId}`}
                        title={label}
                        description={index === 0 ? t('settingsProvidersCollection.overridesDescription') : undefined}
                    >
                        {rows}
                    </ItemGroup>
                );
            })}
        </CorePluginUiPresentationScope>
    );
}
