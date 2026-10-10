import * as React from 'react';
import { readBundledProviderWireProtocolFactV1, type BundledProviderWireProtocol, type ProviderWireProtocol } from '@happier-dev/protocol/providers/capabilities/v1';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { DaemonProviderContributionAuthoringPreviewV1 } from '@happier-dev/protocol/rpc';
import { useUnistyles } from 'react-native-unistyles';

import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { Switch } from '@/components/ui/forms/Switch';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { t } from '@/text';
import { ProviderErrorItems } from '../ProviderErrorItems';
import { ProviderExternalLinkItem } from '../ProviderExternalLinkItem';
import { ProviderSavedSecretControl } from '../ProviderPageParts';
import { ProviderFieldRow } from './ProviderFieldRow';

type PreviewCredential = Readonly<{ required: boolean }>;

/**
 * Translated endpoint labels exist only for the protocols this build bundles a
 * copy string for. A protocol contributed by an installed plugin has none, so
 * the endpoint is labelled with the protocol id the plugin declared rather than
 * with another protocol's label or an unresolved translation key.
 */
const BUNDLED_PROTOCOL_LABEL_KEYS = {
    anthropic: 'settingsProviders.authoring.protocol.anthropic.title',
    'openai-chat': 'settingsProviders.authoring.protocol.openai-chat.title',
    'openai-responses': 'settingsProviders.authoring.protocol.openai-responses.title',
    'ollama-native': null,
} as const satisfies Record<BundledProviderWireProtocol, string | null>;

function endpointProtocolLabel(protocol: ProviderWireProtocol): string {
    const key = readBundledProviderWireProtocolFactV1(BUNDLED_PROTOCOL_LABEL_KEYS, protocol);
    return key === null ? protocol : t(key);
}

/**
 * A provider from the catalog being added in the Providers collection, in one step: its key, an
 * optional name and whether to offer it at once in one sheet (and, where the catalog asks, its
 * endpoints); Connect saves it. Where its requests go is shown only where it is a decision: a choice
 * between destinations, or a destination on one computer.
 */
export function BuiltInProviderAuthoringView(props: Readonly<{
    /** The optional Name row, owned by the screen that holds the draft. */
    nameField?: React.ReactNode;
    machineId: string | null;
    currentMachineName: string;
    providerName: string | null;
    icon: string | null;
    provenance: 'first_party' | 'external' | null;
    websiteUrl?: string;
    keyUrl?: string;
    previewCredential: PreviewCredential | null;
    endpointTemplates: readonly Readonly<{
        id: string;
        protocol: ProviderWireProtocol;
    }>[];
    endpointValues: Readonly<Record<string, string>>;
    secretSelected: boolean;
    savedSecretSelectionEnabled: boolean;
    preview: DaemonProviderContributionAuthoringPreviewV1 | null;
    previewLoading: boolean;
    enableAfterSaving: boolean;
    savePending: boolean;
    error: ProviderErrorV1 | string | null;
    errorRetry?: () => void | Promise<void>;
    secondaryTextColor: string;
    warningColor: string;
    onPickSecret: () => void;
    onChooseCandidate: (candidateId: string) => void;
    onEndpointChange: (endpointTemplateId: string, baseUrl: string) => void;
    onEnableAfterSavingChange: (enabled: boolean) => void;
    onSave: () => void;
    onOpenWebsite: (url: string) => void;
    onDiscard: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const menuActions: PageHeaderMenuAction[] = [
        ...(props.websiteUrl ? [{
            id: 'website',
            testID: 'settings-provider-authoring-website',
            title: t('settingsProviders.links.providerWebsite'),
            onSelect: () => props.onOpenWebsite(props.websiteUrl!),
        }] : []),
    ];
    const connectBlocked = Boolean(props.previewCredential?.required && !props.savedSecretSelectionEnabled);
    return (
        <ItemList testID="settings-provider-authoring-built-in">
            <PageHeader
                testID="settings-provider-authoring-header"
                alwaysShowTitle
                title={props.providerName
                    ? t('settingsProvidersCollection.addTitle', { provider: props.providerName })
                    : t('settingsProviders.authoring.providerTitle')}
                titleAccessory={props.provenance === 'external' ? (
                    <StatusPill
                        testID="settings-provider-authoring-experimental"
                        variant="warning"
                        label={t('settingsProviders.compatibility.experimental')}
                        hideDot
                    />
                ) : undefined}
                description={props.provenance === 'external'
                    ? t('settingsProviders.compatibility.experimentalDescription')
                    : props.providerName
                        ? t('settingsProvidersCollection.addDescription', { provider: props.providerName })
                        : t('settingsProviders.authoring.builtInDescription')}
                leading={(
                    <PageHeaderMarkSlot>
                        <ProviderIcon icon={props.icon} size={24} color={theme.colors.text.secondary} />
                    </PageHeaderMarkSlot>
                )}
                primaryAction={{
                    testID: 'settings-provider-authoring-connect',
                    title: t('settingsProvidersCollection.connect'),
                    loading: props.savePending || props.previewLoading,
                    disabled: connectBlocked || props.preview?.status !== 'resolved' || props.previewLoading,
                    // Connect acts only on a reviewed destination, even for a stale callback.
                    onPress: () => {
                        if (props.preview?.status === 'resolved' && !props.previewLoading && !connectBlocked) props.onSave();
                    },
                }}
                cancelAction={{
                    testID: 'settings-provider-authoring-cancel',
                    title: t('common.cancel'),
                    disabled: props.savePending,
                    onPress: props.onDiscard,
                }}
                actions={menuActions.length > 0 ? <PageHeaderMenu testID="settings-provider-authoring-menu" actions={menuActions} /> : undefined}
            />
            {props.error ? <ItemGroup><ProviderErrorItems error={props.error} retry={props.errorRetry} /></ItemGroup> : null}
            <ItemGroup>
                {props.previewCredential ? (
                    <>
                        <Item
                            testID="settings-provider-authoring-api-key"
                            title={t('settingsProviders.authoring.apiKey')}
                            subtitle={!props.savedSecretSelectionEnabled
                                ? t('settingsProviders.local.accountScopeMismatchDescription')
                                : props.previewCredential.required
                                    ? t('settingsProvidersCollection.addKeyDescription')
                                    : t('settingsProviders.authoring.apiKeyOptionalDescription')}
                            subtitleLines={0}
                            showChevron={false}
                            rightElement={(
                                <ProviderSavedSecretControl
                                    testID="settings-provider-authoring-api-key"
                                    saved={props.secretSelected}
                                    disabled={!props.savedSecretSelectionEnabled}
                                    onChoose={props.onPickSecret}
                                />
                            )}
                            rightElementOutsidePressable
                        />
                        {props.keyUrl ? (
                            <ProviderExternalLinkItem kind="getApiKey" url={props.keyUrl} />
                        ) : null}
                    </>
                ) : null}
                {props.nameField}
                <Item
                    title={t('settingsProviders.authoring.enableAfterSaving')}
                    subtitle={t('settingsProviders.authoring.enableAccountWide')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch testID="settings-provider-authoring-enable-after-save" accessibilityLabel={t('settingsProviders.authoring.enableAfterSaving')} value={props.enableAfterSaving} onValueChange={props.onEnableAfterSavingChange} />}
                    rightElementOutsidePressable
                />
            </ItemGroup>
            {props.endpointTemplates.length > 0 ? (
                <ItemGroup title={t('settingsProvidersCollection.endpointsTitle')} description={t('settingsProvidersCollection.endpointsDescription')}>
                    {props.endpointTemplates.map((endpoint) => (
                        <ProviderFieldRow
                            key={endpoint.id}
                            testID={`settings-provider-authoring-endpoint-${endpoint.id}`}
                            title={endpointProtocolLabel(endpoint.protocol)}
                            value={props.endpointValues[endpoint.id] ?? ''}
                            placeholder={t('settingsProviders.authoring.baseUrlPlaceholder')}
                            keyboardType="url"
                            monospace
                            onChangeText={(baseUrl) => props.onEndpointChange(endpoint.id, baseUrl)}
                        />
                    ))}
                </ItemGroup>
            ) : null}
            {/* Where requests go is asked only when there is a choice to make; Connect waits for it. */}
            <PoliteAccessibilityStatus
                statusTestID="settings-provider-authoring-destination-status"
                transitionKey={props.previewLoading ? 'resolving' : 'settled'}
                announcement={props.previewLoading ? t('settingsProviders.authoring.destinationLoading') : ''}
            />
            {!props.previewLoading && props.preview?.status === 'selection_required' ? (
                <ItemGroup
                    title={t('settingsProviders.authoring.destinationReview')}
                    description={t('settingsProvidersCollection.destinationDescription')}
                >
                    <Item mode="info" title={t('settingsProviders.authoring.destinationSelection')} subtitle={t('settingsProviders.authoring.destinationSelectionDescription')} subtitleLines={0} />
                    {props.preview.candidates.map((candidate) => (
                        <Item
                            key={candidate.candidateId}
                            testID={`settings-provider-authoring-candidate:${candidate.candidateId}`}
                            title={candidate.endpoints[0]?.normalizedUrl ?? t('settingsProviders.authoring.destinationReview')}
                            subtitle={candidate.scope === 'machine'
                                ? `${t('settingsProviders.authoring.destinationMachine')} · ${candidate.machineId === props.machineId ? props.currentMachineName : candidate.machineId}`
                                : t('settingsProviders.authoring.destinationAccount')}
                            onPress={() => props.onChooseCandidate(candidate.candidateId)}
                        />
                    ))}
                </ItemGroup>
            ) : null}
            {!props.previewLoading && props.preview?.status === 'resolved' && props.preview.scope === 'machine' ? (
                <ItemGroup
                    title={t('settingsProviders.authoring.destinationReview')}
                    description={t('settingsProvidersCollection.destinationDescription')}
                >
                    <Item
                        testID="settings-provider-authoring-destination-scope"
                        title={t('settingsProviders.authoring.destinationScope')}
                        subtitle={`${t('settingsProviders.authoring.destinationMachine')} · ${props.preview.machineId === props.machineId ? props.currentMachineName : props.preview.machineId}`}
                        mode="info"
                    />
                    {props.preview.endpoints.map((endpoint) => (
                        <Item
                            key={endpoint.endpointTemplateId}
                            testID={`settings-provider-authoring-resolved-endpoint:${endpoint.endpointTemplateId}`}
                            title={endpoint.protocol}
                            subtitle={endpoint.normalizedUrl}
                            mode="info"
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
}
