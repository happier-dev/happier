import * as React from 'react';
import { View, type TextInput } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { CustomProviderAdvancedEndpointDraft, CustomProviderDraft } from '@/providers/authoring/state';
import { t } from '@/text';

const styles = StyleSheet.create(() => ({
    fields: { gap: 16, paddingHorizontal: 16, paddingVertical: 14 },
    multiline: { minHeight: 88, textAlignVertical: 'top' },
}));

const CREDENTIAL_STYLES = ['bearer', 'x-api-key', 'api-key', 'custom-header', 'custom-header-bearer'] as const;

export const CustomProviderAdvancedFields = React.memo(function CustomProviderAdvancedFields(props: Readonly<{
    draft: CustomProviderDraft;
    baseUrlFieldRef: React.RefObject<TextInput | null>;
    onChange: React.Dispatch<React.SetStateAction<CustomProviderDraft>>;
}>) {
    const [credentialMenu, setCredentialMenu] = React.useState<string | null>(null);
    const [probeParserMenu, setProbeParserMenu] = React.useState<string | null>(null);
    const credentialStyles = React.useMemo<readonly DropdownMenuItem[]>(() => [
        { id: 'bearer', title: t('settingsProviders.authoring.credentialStyle.bearer') },
        { id: 'x-api-key', title: t('settingsProviders.authoring.credentialStyle.xApiKey') },
        { id: 'api-key', title: t('settingsProviders.authoring.credentialStyle.apiKey') },
        { id: 'custom-header', title: t('settingsProviders.authoring.credentialStyle.customHeader') },
        { id: 'custom-header-bearer', title: t('settingsProviders.authoring.credentialStyle.customHeaderBearer') },
    ], []);
    const probeParsers = React.useMemo<readonly DropdownMenuItem[]>(() => [
        { id: 'openai-models', title: t('settingsProviders.authoring.probeParser.openaiModels') },
        { id: 'ollama-tags', title: t('settingsProviders.authoring.probeParser.ollamaTags') },
        { id: 'lmstudio-native-models', title: t('settingsProviders.authoring.probeParser.lmStudioNative') },
    ], []);
    const focusEndpointProtocol = props.draft.endpoints.find((endpoint) => endpoint.enabled)?.protocol ?? null;
    const update = React.useCallback((protocol: CustomProviderAdvancedEndpointDraft['protocol'], patch: Partial<CustomProviderAdvancedEndpointDraft>) => {
        props.onChange((current) => ({
            ...current,
            endpoints: current.endpoints.map((endpoint) => endpoint.protocol === protocol ? { ...endpoint, ...patch } : endpoint),
        }));
    }, [props]);

    return props.draft.endpoints.map((endpoint) => {
        const protocolTitle = t(`settingsProviders.authoring.protocol.${endpoint.protocol}.title`);
        const controlLabel = (action: string) => `${protocolTitle}, ${action}`;
        return (
        <ItemGroup
            key={endpoint.protocol}
            title={protocolTitle}
            footer={t(`settingsProviders.authoring.protocol.${endpoint.protocol}.description`)}
        >
            <Item
                title={t('settingsProviders.authoring.endpointEnabled')}
                subtitle={endpoint.enabled
                    ? t('settingsProviders.authoring.endpointEnabledDescription')
                    : t('settingsProviders.authoring.endpointDisabledDescription')}
                rightElement={<Switch accessibilityLabel={controlLabel(t('settingsProviders.authoring.endpointEnabled'))} value={endpoint.enabled} onValueChange={(enabled) => update(endpoint.protocol, { enabled })} />}
                rightElementOutsidePressable
            />
            {endpoint.enabled ? (
                <>
                    <View style={styles.fields}>
                        <MachineSetupTextField
                            ref={endpoint.protocol === focusEndpointProtocol ? props.baseUrlFieldRef : undefined}
                            testID={endpoint.protocol === focusEndpointProtocol ? 'settings-provider-authoring-base-url' : undefined}
                            label={t('settingsProviders.authoring.baseUrl')}
                            value={endpoint.baseUrl}
                            placeholder={t('settingsProviders.authoring.baseUrlPlaceholder')}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            onChangeText={(baseUrl) => update(endpoint.protocol, { baseUrl })}
                        />
                        <MachineSetupTextField
                            label={t('settingsProviders.authoring.publicHeaders')}
                            value={endpoint.publicHeadersText}
                            placeholder={t('settingsProviders.authoring.publicHeadersPlaceholder')}
                            autoCapitalize="none"
                            autoCorrect={false}
                            multiline
                            inputStyle={styles.multiline}
                            onChangeText={(publicHeadersText) => update(endpoint.protocol, { publicHeadersText })}
                        />
                        <MachineSetupTextField
                            label={t('settingsProviders.authoring.optionalProbePath')}
                            value={endpoint.probePathsText}
                            placeholder={t('settingsProviders.authoring.modelsPathPlaceholder')}
                            autoCapitalize="none"
                            autoCorrect={false}
                            multiline
                            inputStyle={styles.multiline}
                            onChangeText={(probePathsText) => update(endpoint.protocol, { probePathsText })}
                        />
                        {endpoint.probePathsText.trim() ? (
                            <DropdownMenu
                                open={probeParserMenu === endpoint.protocol}
                                onOpenChange={(open) => setProbeParserMenu(open ? endpoint.protocol : null)}
                                variant="selectable"
                                search={false}
                                selectedId={endpoint.probeParser}
                                showCategoryTitles={false}
                                rowKind="item"
                                itemTrigger={{
                                    title: t('settingsProviders.authoring.probeParserTitle'),
                                    subtitle: probeParsers.find((item) => item.id === endpoint.probeParser)?.title,
                                    showSelectedDetail: false,
                                    showSelectedSubtitle: false,
                                }}
                                items={probeParsers}
                                onSelect={(probeParser) => {
                                    if (probeParser === 'openai-models' || probeParser === 'ollama-tags' || probeParser === 'lmstudio-native-models') {
                                        update(endpoint.protocol, { probeParser });
                                    }
                                }}
                            />
                        ) : null}
                    </View>
                    <Item
                        title={t('settingsProviders.authoring.requiresApiKey')}
                        subtitle={endpoint.requiresApiKey
                            ? t('settingsProviders.authoring.requiresApiKeyYes')
                            : t('settingsProviders.authoring.requiresApiKeyNo')}
                        rightElement={<Switch accessibilityLabel={controlLabel(t('settingsProviders.authoring.requiresApiKey'))} value={endpoint.requiresApiKey} onValueChange={(requiresApiKey) => update(endpoint.protocol, { requiresApiKey })} />}
                        rightElementOutsidePressable
                    />
                    {endpoint.requiresApiKey ? (
                        <>
                            <DropdownMenu
                                open={credentialMenu === endpoint.protocol}
                                onOpenChange={(open) => setCredentialMenu(open ? endpoint.protocol : null)}
                                variant="selectable"
                                search={false}
                                selectedId={endpoint.credentialStyle}
                                showCategoryTitles={false}
                                rowKind="item"
                                itemTrigger={{
                                    title: t('settingsProviders.authoring.credentialStyleTitle'),
                                    subtitle: credentialStyles.find((item) => item.id === endpoint.credentialStyle)?.title,
                                    showSelectedDetail: false,
                                    showSelectedSubtitle: false,
                                }}
                                items={credentialStyles}
                                onSelect={(style) => {
                                    if (CREDENTIAL_STYLES.includes(style as typeof CREDENTIAL_STYLES[number])) {
                                        update(endpoint.protocol, { credentialStyle: style as typeof CREDENTIAL_STYLES[number] });
                                    }
                                }}
                            />
                            {endpoint.credentialStyle === 'custom-header' || endpoint.credentialStyle === 'custom-header-bearer' ? (
                                <View style={styles.fields}>
                                    <MachineSetupTextField
                                        label={t('settingsProviders.authoring.credentialHeader')}
                                        value={endpoint.credentialHeader}
                                        placeholder={t('settingsProviders.authoring.credentialHeaderPlaceholder')}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        onChangeText={(credentialHeader) => update(endpoint.protocol, { credentialHeader })}
                                    />
                                </View>
                            ) : null}
                        </>
                    ) : null}
                </>
            ) : null}
        </ItemGroup>
        );
    });
});
