import * as React from 'react';
import type { TextInput } from 'react-native';
import { BUNDLED_PROVIDER_CATALOG_PARSERS_V1, BundledProviderCatalogParserV1Schema, type BundledProviderCatalogParserV1 } from '@happier-dev/protocol/providers/catalog/descriptorV1';
import { CustomProviderCredentialStyleV1Schema, type CustomProviderCredentialStyleV1 } from '@happier-dev/protocol/providers/connections/normalizeCustomTemplateV1';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { CustomProviderAdvancedEndpointDraft, CustomProviderDraft } from '@/providers/authoring/state';
import { ProviderFieldRow } from './authoring/ProviderFieldRow';
import { t } from '@/text';

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
            description={t(`settingsProviders.authoring.protocol.${endpoint.protocol}.description`)}
        >
            <Item
                title={t('settingsProviders.authoring.endpointEnabled')}
                subtitle={endpoint.enabled
                    ? t('settingsProviders.authoring.endpointEnabledDescription')
                    : t('settingsProviders.authoring.endpointDisabledDescription')}
                showChevron={false}
                rightElement={<Switch accessibilityLabel={controlLabel(t('settingsProviders.authoring.endpointEnabled'))} value={endpoint.enabled} onValueChange={(enabled) => update(endpoint.protocol, { enabled })} />}
                rightElementOutsidePressable
            />
            {endpoint.enabled ? (
                <>
                    <ProviderFieldRow
                        ref={endpoint.protocol === focusEndpointProtocol ? props.baseUrlFieldRef : undefined}
                        testID={endpoint.protocol === focusEndpointProtocol ? 'settings-provider-authoring-base-url' : `settings-provider-authoring-base-url:${endpoint.protocol}`}
                        title={t('settingsProviders.authoring.baseUrl')}
                        value={endpoint.baseUrl}
                        placeholder={t('settingsProviders.authoring.baseUrlPlaceholder')}
                        keyboardType="url"
                        monospace
                        onChangeText={(baseUrl) => update(endpoint.protocol, { baseUrl })}
                    />
                    <ProviderFieldRow
                        testID={`settings-provider-authoring-public-headers:${endpoint.protocol}`}
                        title={t('settingsProviders.authoring.publicHeaders')}
                        value={endpoint.publicHeadersText}
                        placeholder={t('settingsProviders.authoring.publicHeadersPlaceholder')}
                        multiline
                        monospace
                        onChangeText={(publicHeadersText) => update(endpoint.protocol, { publicHeadersText })}
                    />
                    <ProviderFieldRow
                        testID={`settings-provider-authoring-probe-paths:${endpoint.protocol}`}
                        title={t('settingsProviders.authoring.optionalProbePath')}
                        value={endpoint.probePathsText}
                        placeholder={t('settingsProviders.authoring.modelsPathPlaceholder')}
                        multiline
                        monospace
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
                                showSelectedDetail: true,
                                showSelectedSubtitle: false,
                            }}
                            items={probeParsers}
                            onSelect={(probeParser) => {
                                const parsed = BundledProviderCatalogParserV1Schema.safeParse(probeParser);
                                if (parsed.success) update(endpoint.protocol, { probeParser: parsed.data });
                            }}
                        />
                    ) : null}
                    <Item
                        title={t('settingsProviders.authoring.requiresApiKey')}
                        subtitle={endpoint.requiresApiKey
                            ? t('settingsProviders.authoring.requiresApiKeyYes')
                            : t('settingsProviders.authoring.requiresApiKeyNo')}
                        showChevron={false}
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
                                    showSelectedDetail: true,
                                    showSelectedSubtitle: false,
                                }}
                                items={credentialStyles}
                                onSelect={(style) => {
                                    const parsed = CustomProviderCredentialStyleV1Schema.safeParse(style);
                                    if (parsed.success) update(endpoint.protocol, { credentialStyle: parsed.data });
                                }}
                            />
                            {endpoint.credentialStyle === 'custom-header' || endpoint.credentialStyle === 'custom-header-bearer' ? (
                                <ProviderFieldRow
                                    testID={`settings-provider-authoring-credential-header:${endpoint.protocol}`}
                                    title={t('settingsProviders.authoring.credentialHeader')}
                                    value={endpoint.credentialHeader}
                                    placeholder={t('settingsProviders.authoring.credentialHeaderPlaceholder')}
                                    monospace
                                    onChangeText={(credentialHeader) => update(endpoint.protocol, { credentialHeader })}
                                />
                            ) : null}
                        </>
                    ) : null}
                </>
            ) : null}
        </ItemGroup>
        );
    });
});
