import * as React from 'react';
import {
    readBundledProviderWireProtocolFactV1,
    type BundledProviderWireProtocol,
    type ProviderErrorV1,
    type ProviderWireProtocol,
} from '@happier-dev/protocol';
import type { DaemonProviderContributionAuthoringPreviewV1 } from '@happier-dev/protocol/rpc';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { Switch } from '@/components/ui/forms/Switch';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { ProviderErrorItems } from '../ProviderErrorItems';
import { ProviderExternalLinkItem } from '../ProviderExternalLinkItem';
import { ProviderMachineSelector } from '../ProviderMachineSelector';
import { Icon } from '@/components/ui/icons/Icon';

type PreviewCredential = Readonly<{ required: boolean }>;

const styles = StyleSheet.create(() => ({
    fields: { gap: 16, paddingHorizontal: 16, paddingVertical: 14 },
}));

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

export function BuiltInProviderAuthoringView(props: Readonly<{
    targetMachines: readonly Machine[];
    machineId: string;
    currentMachineName: string;
    providerName: string | null;
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
    preview: DaemonProviderContributionAuthoringPreviewV1 | null;
    previewLoading: boolean;
    enableAfterSaving: boolean;
    savePending: boolean;
    error: ProviderErrorV1 | string | null;
    errorRetry?: () => void | Promise<void>;
    secondaryTextColor: string;
    warningColor: string;
    onSelectMachine: (machineId: string) => void;
    onPickSecret: () => void;
    onChooseCandidate: (candidateId: string) => void;
    onEndpointChange: (endpointTemplateId: string, baseUrl: string) => void;
    onEnableAfterSavingChange: (enabled: boolean) => void;
    onSave: () => void;
}>): React.ReactElement {
    return (
        <ItemList testID="settings-provider-authoring-built-in" style={{ paddingTop: 0 }}>
            {props.targetMachines.length > 1 ? (
                <ItemGroup title={t('settingsProviders.detail.targetMachine')}>
                    <ProviderMachineSelector machines={props.targetMachines} selectedId={props.machineId} onSelect={props.onSelectMachine} />
                </ItemGroup>
            ) : null}
            <ItemGroup title={props.providerName ?? t('settingsProviders.authoring.providerTitle')} footer={t('settingsProviders.authoring.builtInDescription')}>
                {props.provenance === 'external' ? (
                    <Item
                        testID="settings-provider-authoring-experimental"
                        mode="info"
                        title={t('settingsProviders.compatibility.experimental')}
                        subtitle={t('settingsProviders.compatibility.experimentalDescription')}
                        icon={<Icon name="warning" size={29} color={props.warningColor} />}
                    />
                ) : null}
                {props.websiteUrl ? (
                    <ProviderExternalLinkItem kind="providerWebsite" url={props.websiteUrl} />
                ) : null}
                {props.previewCredential ? (
                    <Item
                        testID="settings-provider-authoring-api-key"
                        title={t('settingsProviders.authoring.apiKey')}
                        subtitle={props.secretSelected
                            ? t('settingsProviders.detail.apiKeySelected')
                            : props.previewCredential.required
                                ? t('settingsProviders.authoring.apiKeyDescription')
                                : t('settingsProviders.authoring.apiKeyOptionalDescription')}
                        icon={<Icon name="key" size={29} color={props.secondaryTextColor} />}
                        onPress={props.onPickSecret}
                    />
                ) : null}
                {props.keyUrl ? (
                    <ProviderExternalLinkItem kind="getApiKey" url={props.keyUrl} />
                ) : null}
                {props.endpointTemplates.length > 0 ? (
                    <View style={styles.fields}>
                        {props.endpointTemplates.map((endpoint) => (
                            <MachineSetupTextField
                                key={endpoint.id}
                                testID={`settings-provider-authoring-endpoint-${endpoint.id}`}
                                label={endpointProtocolLabel(endpoint.protocol)}
                                value={props.endpointValues[endpoint.id] ?? ''}
                                placeholder={t('settingsProviders.authoring.baseUrlPlaceholder')}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                onChangeText={(baseUrl) => props.onEndpointChange(endpoint.id, baseUrl)}
                            />
                        ))}
                    </View>
                ) : null}
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
                        <Item mode="info" title={t('settingsProviders.authoring.destinationSelection')} subtitle={t('settingsProviders.authoring.destinationSelectionDescription')} />
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
                        />
                        {props.preview.endpoints.map((endpoint) => (
                            <Item
                                key={endpoint.endpointTemplateId}
                                testID={`settings-provider-authoring-resolved-endpoint:${endpoint.endpointTemplateId}`}
                                title={endpoint.protocol}
                                subtitle={endpoint.normalizedUrl}
                            />
                        ))}
                    </>
                ) : null}
                <Item
                    title={t('settingsProviders.authoring.enableAfterSaving')}
                    subtitle={t('settingsProviders.authoring.enableAccountWide')}
                    rightElement={<Switch testID="settings-provider-authoring-enable-after-save" accessibilityLabel={t('settingsProviders.authoring.enableAfterSaving')} value={props.enableAfterSaving} onValueChange={props.onEnableAfterSavingChange} />}
                    rightElementOutsidePressable
                />
                <Item
                    testID="settings-provider-authoring-connect"
                    title={t('settingsProviders.authoring.connect')}
                    loading={props.savePending || props.previewLoading}
                    onPress={props.preview?.status === 'resolved' && !props.previewLoading ? props.onSave : undefined}
                />
            </ItemGroup>
            {props.error ? <ItemGroup><ProviderErrorItems error={props.error} retry={props.errorRetry} /></ItemGroup> : null}
        </ItemList>
    );
}
