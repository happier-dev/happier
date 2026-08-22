import * as React from 'react';
import { View, type TextInput } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    BUNDLED_PROVIDER_CATALOG_PARSERS_V1,
    BundledProviderCatalogParserV1Schema,
    CustomProviderCredentialStyleV1Schema,
    type BundledProviderCatalogParserV1,
    type CustomProviderCredentialStyleV1,
} from '@happier-dev/protocol';

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

/**
 * Titles only. MEMBERSHIP of both vocabularies is owned by Protocol; these maps
 * are exhaustive over it, so a credential style or bundled catalog format added
 * upstream fails this screen's typecheck instead of silently losing its picker
 * row. Presentation copy stays here and is never pushed into Protocol.
 */
const CREDENTIAL_STYLE_TITLE_KEYS = {
    bearer: 'settingsProviders.authoring.credentialStyle.bearer',
    'x-api-key': 'settingsProviders.authoring.credentialStyle.xApiKey',
    'api-key': 'settingsProviders.authoring.credentialStyle.apiKey',
    'custom-header': 'settingsProviders.authoring.credentialStyle.customHeader',
    'custom-header-bearer': 'settingsProviders.authoring.credentialStyle.customHeaderBearer',
} as const satisfies Record<CustomProviderCredentialStyleV1, string>;

const PROBE_PARSER_TITLE_KEYS = {
    'openai-models': 'settingsProviders.authoring.probeParser.openaiModels',
    'anthropic-models': 'settingsProviders.authoring.protocol.anthropic.title',
    'ollama-tags': 'settingsProviders.authoring.probeParser.ollamaTags',
    'lmstudio-native-models': 'settingsProviders.authoring.probeParser.lmStudioNative',
} as const satisfies Record<BundledProviderCatalogParserV1, string>;

export const CustomProviderAdvancedFields = React.memo(function CustomProviderAdvancedFields(props: Readonly<{
    draft: CustomProviderDraft;
    baseUrlFieldRef: React.RefObject<TextInput | null>;
    onChange: React.Dispatch<React.SetStateAction<CustomProviderDraft>>;
}>) {
    const [credentialMenu, setCredentialMenu] = React.useState<string | null>(null);
    const [probeParserMenu, setProbeParserMenu] = React.useState<string | null>(null);
    const credentialStyles = React.useMemo<readonly DropdownMenuItem[]>(
        () => CustomProviderCredentialStyleV1Schema.options.map((id) => ({
            id,
            title: t(CREDENTIAL_STYLE_TITLE_KEYS[id]),
        })),
        [],
    );
    const probeParsers = React.useMemo<readonly DropdownMenuItem[]>(
        () => BUNDLED_PROVIDER_CATALOG_PARSERS_V1.map((id) => ({
            id,
            title: t(PROBE_PARSER_TITLE_KEYS[id]),
        })),
        [],
    );
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
                                    const parsed = BundledProviderCatalogParserV1Schema.safeParse(probeParser);
                                    if (parsed.success) update(endpoint.protocol, { probeParser: parsed.data });
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
                                    const parsed = CustomProviderCredentialStyleV1Schema.safeParse(style);
                                    if (parsed.success) update(endpoint.protocol, { credentialStyle: parsed.data });
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
