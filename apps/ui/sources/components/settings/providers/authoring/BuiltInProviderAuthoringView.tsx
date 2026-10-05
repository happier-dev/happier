import * as React from 'react';
import {
    readBundledProviderWireProtocolFactV1,
    type BundledProviderWireProtocol,
    type ProviderErrorV1,
    type ProviderWireProtocol,
} from '@happier-dev/protocol';
import type { DaemonProviderContributionAuthoringPreviewV1 } from '@happier-dev/protocol/rpc';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
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
import { ProviderHeaderActions, ProviderSavedSecretControl } from '../ProviderPageParts';
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
 * A provider from the catalog being added in the Providers collection. The page is the draft's
 * editor: choose its key and, where the catalog asks, its endpoints; Connect saves it.
 */
export function BuiltInProviderAuthoringView(props: Readonly<{
    /** The managed machine the provider is added on (its chip). */
    contextBar?: React.ReactNode;
    nameField?: React.ReactNode;
    machineId: string;
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
            {props.contextBar}
            <PageHeader
                testID="settings-provider-authoring-header"
                alwaysShowTitle
                title={props.providerName ?? t('settingsProviders.authoring.providerTitle')}
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
                    : t('settingsProviders.authoring.builtInDescription')}
                leading={(
                    <PageHeaderMarkSlot>
                        <ProviderIcon icon={props.icon} size={24} color={theme.colors.text.secondary} />
                    </PageHeaderMarkSlot>
                )}
                actions={(
                    <ProviderHeaderActions>
                        <RoundButton
                            testID="settings-provider-authoring-connect"
                            size="small"
                            title={t('settingsProvidersCollection.connect')}
                            accessibilityLabel={t('settingsProviders.authoring.connect')}
                            loading={props.savePending || props.previewLoading}
                            disabled={connectBlocked || props.preview?.status !== 'resolved' || props.previewLoading}
                            // Connect acts only on a reviewed destination.
                            onPress={props.preview?.status === 'resolved' && !props.previewLoading ? props.onSave : undefined}
                        />
                        <RoundButton
                            testID="settings-provider-authoring-cancel"
                            size="small"
                            display="secondary"
                            title={t('common.cancel')}
                            disabled={props.savePending}
                            onPress={props.onDiscard}
                        />
                        {menuActions.length > 0 ? <PageHeaderMenu testID="settings-provider-authoring-menu" actions={menuActions} /> : null}
                    </ProviderHeaderActions>
                )}
            />
            {props.nameField}
            {props.error ? <ItemGroup><ProviderErrorItems error={props.error} retry={props.errorRetry} /></ItemGroup> : null}
            {props.previewCredential ? (
                <ItemGroup title={t('settingsProviders.detail.apiKeyTitle')} description={t('settingsProviders.detail.apiKeyFooter')}>
                    <Item
                        testID="settings-provider-authoring-api-key"
                        title={t('settingsProviders.authoring.apiKey')}
                        subtitle={!props.savedSecretSelectionEnabled
                            ? t('settingsProviders.local.accountScopeMismatchDescription')
                            : props.previewCredential.required
                                ? t('settingsProviders.authoring.apiKeyDescription')
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
                </ItemGroup>
            ) : null}
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
            <ItemGroup
                title={t('settingsProviders.authoring.destinationReview')}
                description={t('settingsProvidersCollection.destinationDescription')}
            >
                {props.previewLoading ? (
                    <View
                        testID="settings-provider-authoring-destination-status"
                        accessibilityRole="text"
                        accessibilityLiveRegion="polite"
                        role="status"
                        aria-live="polite"
                    >
                        <Item mode="info" title={t('settingsProviders.authoring.destinationReview')} subtitle={t('settingsProviders.authoring.destinationLoading')} loading />
                    </View>
                ) : props.preview?.status === 'selection_required' ? (
                    <>
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
                    </>
                ) : props.preview?.status === 'resolved' ? (
                    <>
                        <Item
                            testID="settings-provider-authoring-destination-scope"
                            title={t('settingsProviders.authoring.destinationScope')}
                            subtitle={props.preview.scope === 'machine'
                                ? `${t('settingsProviders.authoring.destinationMachine')} · ${props.preview.machineId === props.machineId ? props.currentMachineName : props.preview.machineId}`
                                : t('settingsProviders.authoring.destinationAccount')}
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
                    </>
                ) : (
                    <Item mode="info" title={t('settingsProviders.authoring.destinationReview')} subtitle={t('settingsProvidersCollection.destinationPending')} subtitleLines={0} />
                )}
            </ItemGroup>
            <ItemGroup title={t('settingsProvidersCollection.afterSavingTitle')}>
                <Item
                    title={t('settingsProviders.authoring.enableAfterSaving')}
                    subtitle={t('settingsProviders.authoring.enableAccountWide')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch testID="settings-provider-authoring-enable-after-save" accessibilityLabel={t('settingsProviders.authoring.enableAfterSaving')} value={props.enableAfterSaving} onValueChange={props.onEnableAfterSavingChange} />}
                    rightElementOutsidePressable
                />
            </ItemGroup>
        </ItemList>
    );
}
