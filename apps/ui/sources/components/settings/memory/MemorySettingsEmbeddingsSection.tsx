import * as React from 'react';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { normalizeSecretStringPromptInput } from '@/utils/secrets/normalizeSecretStringPromptInput';

import {
    MemoryEmbeddingsLocalTransformersConfigSchema,
    MemoryEmbeddingsOpenAiCompatibleConfigSchema,
    type MemorySettingsV1,
} from '@happier-dev/protocol/memory/memorySettings';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { MEMORY_SETTINGS } from '@/components/settings/memory/memorySettings';

type EmbeddingsModeOptionId = 'disabled' | 'preset:balanced' | 'preset:long_context' | 'preset:quality' | 'custom';

const DEFAULT_LOCAL_EMBEDDINGS_CUSTOM_CONFIG = MemoryEmbeddingsLocalTransformersConfigSchema.parse({
    kind: 'local_transformers',
});
const DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_CUSTOM_CONFIG = MemoryEmbeddingsOpenAiCompatibleConfigSchema.parse({
    kind: 'openai_compatible',
});

function getEmbeddingsModeOptionId(settings: MemorySettingsV1['embeddings']): EmbeddingsModeOptionId {
    if (settings.mode === 'disabled') return 'disabled';
    if (settings.mode === 'custom') return 'custom';
    return `preset:${settings.presetId}` as EmbeddingsModeOptionId;
}

function updateEmbeddings(
    settings: MemorySettingsV1,
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>,
    nextEmbeddings: MemorySettingsV1['embeddings'],
): void {
    void writeSettings({
        ...settings,
        embeddings: nextEmbeddings,
    });
}

function parseOptionalInteger(value: string | null): number | null {
    if (value === null) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(1, Math.floor(parsed));
}

export const MemorySettingsEmbeddingsSection = React.memo(function MemorySettingsEmbeddingsSection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { settings } = props;
    const [modeMenuOpen, setModeMenuOpen] = React.useState(false);

    if (settings.indexMode !== 'deep') return null;

    const embeddings = settings.embeddings;
    const customProvider = embeddings.mode === 'custom' ? embeddings.custom : null;
    const modeSubtitle = (() => {
        const id = getEmbeddingsModeOptionId(embeddings);
        if (id === 'disabled') return t('memorySearchSettings.embeddings.mode.options.disabledSubtitle');
        if (id === 'custom') return t('memorySearchSettings.embeddings.mode.options.customSubtitle');
        if (id === 'preset:balanced') return t('memorySearchSettings.embeddings.mode.options.balancedSubtitle');
        if (id === 'preset:long_context') return t('memorySearchSettings.embeddings.mode.options.longContextSubtitle');
        return t('memorySearchSettings.embeddings.mode.options.qualitySubtitle');
    })();

    return (
        <SettingSection section={MEMORY_SETTINGS.sectionRefs.embeddings}>
        <ItemGroup
            title={t('memorySearchSettings.embeddings.groupTitle')}
            description={t('memorySearchSettings.embeddings.groupFooter')}
        >
            <SettingAnchor setting={MEMORY_SETTINGS.settings.embeddingsMode}>
            <DropdownMenu
                open={modeMenuOpen}
                onOpenChange={setModeMenuOpen}
                selectedId={getEmbeddingsModeOptionId(embeddings)}
                search={false}
                showCategoryTitles={false}
                itemTrigger={{
                    title: t(MEMORY_SETTINGS.settings.embeddingsMode.titleKey),
                    subtitle: modeSubtitle,
                    itemProps: {
                        testID: 'memory-settings-embeddings-mode',
                    },
                }}
                items={[
                    {
                        id: 'disabled',
                        title: t('memorySearchSettings.embeddings.mode.options.disabledTitle'),
                        subtitle: t('memorySearchSettings.embeddings.mode.options.disabledSubtitle'),
                    },
                    {
                        id: 'preset:balanced',
                        title: t('memorySearchSettings.embeddings.mode.options.balancedTitle'),
                        subtitle: t('memorySearchSettings.embeddings.mode.options.balancedSubtitle'),
                    },
                    {
                        id: 'preset:long_context',
                        title: t('memorySearchSettings.embeddings.mode.options.longContextTitle'),
                        subtitle: t('memorySearchSettings.embeddings.mode.options.longContextSubtitle'),
                    },
                    {
                        id: 'preset:quality',
                        title: t('memorySearchSettings.embeddings.mode.options.qualityTitle'),
                        subtitle: t('memorySearchSettings.embeddings.mode.options.qualitySubtitle'),
                    },
                    {
                        id: 'custom',
                        title: t('memorySearchSettings.embeddings.mode.options.customTitle'),
                        subtitle: t('memorySearchSettings.embeddings.mode.options.customSubtitle'),
                    },
                ]}
                onSelect={(id) => {
                    setModeMenuOpen(false);
                    if (id === 'disabled') {
                        updateEmbeddings(settings, props.writeSettings, {
                            ...embeddings,
                            mode: 'disabled',
                        });
                        return;
                    }
                    if (id === 'custom') {
                        updateEmbeddings(settings, props.writeSettings, {
                            ...embeddings,
                            mode: 'custom',
                            custom: embeddings.custom ?? DEFAULT_LOCAL_EMBEDDINGS_CUSTOM_CONFIG,
                        });
                        return;
                    }
                    const presetId = id.replace('preset:', '') as MemorySettingsV1['embeddings']['presetId'];
                    updateEmbeddings(settings, props.writeSettings, {
                        ...embeddings,
                        mode: 'preset',
                        presetId,
                    });
                }}
            />
            </SettingAnchor>

            {embeddings.mode === 'custom' ? (
                <SettingAnchor setting={MEMORY_SETTINGS.settings.embeddingsProvider}>
                    <SegmentedChoiceItem<'local_transformers' | 'openai_compatible'>
                        testID="memory-settings-embeddings-provider"
                        testIDPrefix="memory-settings-embeddings-provider"
                        title={t(MEMORY_SETTINGS.settings.embeddingsProvider.titleKey)}
                        subtitleLines={0}
                        value={customProvider?.kind ?? 'local_transformers'}
                        options={[
                            {
                                id: 'local_transformers',
                                label: t('memorySearchSettings.embeddings.provider.options.localTitle'),
                                description: t('memorySearchSettings.embeddings.provider.options.localSubtitle'),
                            },
                            {
                                id: 'openai_compatible',
                                label: t('memorySearchSettings.embeddings.provider.options.openAiCompatibleTitle'),
                                description: t('memorySearchSettings.embeddings.provider.options.openAiCompatibleSubtitle'),
                            },
                        ]}
                        onChange={(id) => {
                            if (id === 'openai_compatible') {
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    mode: 'custom',
                                    custom: {
                                        kind: 'openai_compatible',
                                        baseUrl: customProvider?.kind === 'openai_compatible' ? customProvider.baseUrl : null,
                                        apiKey: customProvider?.kind === 'openai_compatible' ? customProvider.apiKey : null,
                                        model: customProvider?.kind === 'openai_compatible'
                                            ? customProvider.model
                                            : DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_CUSTOM_CONFIG.model,
                                        dimensions: customProvider?.kind === 'openai_compatible' ? customProvider.dimensions : null,
                                    },
                                });
                                return;
                            }
                            updateEmbeddings(settings, props.writeSettings, {
                                ...embeddings,
                                mode: 'custom',
                                custom: {
                                    kind: 'local_transformers',
                                    modelId: customProvider?.kind === 'local_transformers'
                                        ? customProvider.modelId
                                        : DEFAULT_LOCAL_EMBEDDINGS_CUSTOM_CONFIG.modelId,
                                    queryPrefix: customProvider?.kind === 'local_transformers' ? customProvider.queryPrefix : null,
                                    documentPrefix: customProvider?.kind === 'local_transformers' ? customProvider.documentPrefix : null,
                                },
                            });
                        }}
                    />
                </SettingAnchor>
            ) : null}

            {customProvider?.kind === 'local_transformers' ? (
                <>
                    <SettingAnchor setting={MEMORY_SETTINGS.settings.localModel}>
                        <FieldValueItem
                            testID="memory-settings-embeddings-local-model"
                            fieldTestID="memory-settings-embeddings-local-model-field"
                            title={t('memorySearchSettings.embeddings.modelTitle')}
                            subtitle={t('memorySearchSettings.embeddings.promptBody')}
                            placeholder={t('memorySearchSettings.embeddings.modelPlaceholder')}
                            monospace
                            value={customProvider.modelId}
                            onCommit={(draft) => {
                                if (!draft) return customProvider.modelId;
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    custom: { ...customProvider, modelId: draft },
                                });
                            }}
                        />
                    </SettingAnchor>
                    <SettingAnchor setting={MEMORY_SETTINGS.settings.queryPrefix}>
                        <FieldValueItem
                            testID="memory-settings-embeddings-local-query-prefix"
                            fieldTestID="memory-settings-embeddings-local-query-prefix-field"
                            title={t('memorySearchSettings.embeddings.queryPrefixTitle')}
                            subtitle={t('memorySearchSettings.embeddings.queryPrefixPromptBody')}
                            placeholder={t('memorySearchSettings.embeddings.notSet')}
                            value={customProvider.queryPrefix ?? ''}
                            onCommit={(draft) => {
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    custom: { ...customProvider, queryPrefix: draft || null },
                                });
                            }}
                        />
                    </SettingAnchor>
                    <SettingAnchor setting={MEMORY_SETTINGS.settings.documentPrefix}>
                        <FieldValueItem
                            testID="memory-settings-embeddings-local-document-prefix"
                            fieldTestID="memory-settings-embeddings-local-document-prefix-field"
                            title={t('memorySearchSettings.embeddings.documentPrefixTitle')}
                            subtitle={t('memorySearchSettings.embeddings.documentPrefixPromptBody')}
                            placeholder={t('memorySearchSettings.embeddings.notSet')}
                            value={customProvider.documentPrefix ?? ''}
                            onCommit={(draft) => {
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    custom: { ...customProvider, documentPrefix: draft || null },
                                });
                            }}
                        />
                    </SettingAnchor>
                </>
            ) : null}

            {customProvider?.kind === 'openai_compatible' ? (
                <>
                    <SettingAnchor setting={MEMORY_SETTINGS.settings.baseUrl}>
                        <FieldValueItem
                            testID="memory-settings-embeddings-openai-base-url"
                            fieldTestID="memory-settings-embeddings-openai-base-url-field"
                            title={t('memorySearchSettings.embeddings.openAi.baseUrlTitle')}
                            subtitle={t('memorySearchSettings.embeddings.openAi.baseUrlPromptBody')}
                            placeholder={t('memorySearchSettings.embeddings.notSet')}
                            monospace
                            value={customProvider.baseUrl ?? ''}
                            onCommit={(draft) => {
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    custom: { ...customProvider, baseUrl: draft || null },
                                });
                            }}
                        />
                    </SettingAnchor>
                    <SettingAnchor setting={MEMORY_SETTINGS.settings.remoteModel}>
                        <FieldValueItem
                            testID="memory-settings-embeddings-openai-model"
                            fieldTestID="memory-settings-embeddings-openai-model-field"
                            title={t('memorySearchSettings.embeddings.openAi.modelTitle')}
                            subtitle={t('memorySearchSettings.embeddings.openAi.modelPromptBody')}
                            monospace
                            value={customProvider.model}
                            onCommit={(draft) => {
                                if (!draft) return customProvider.model;
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    custom: { ...customProvider, model: draft },
                                });
                            }}
                        />
                    </SettingAnchor>
                    {/* The saved key is never shown; typing a new one replaces it. */}
                    <SettingAnchor setting={MEMORY_SETTINGS.settings.apiKey}>
                        <FieldValueItem
                            testID="memory-settings-embeddings-openai-api-key"
                            fieldTestID="memory-settings-embeddings-openai-api-key-field"
                            title={t('memorySearchSettings.embeddings.openAi.apiKeyTitle')}
                            subtitle={t('memorySearchSettings.embeddings.openAi.apiKeyPromptBody')}
                            placeholder={customProvider.apiKey ? t('memorySearchSettings.embeddings.secretSet') : t('memorySearchSettings.embeddings.secretNotSet')}
                            secureTextEntry
                            value=""
                            onCommit={(draft) => {
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    custom: { ...customProvider, apiKey: normalizeSecretStringPromptInput(draft) },
                                });
                                return '';
                            }}
                        />
                    </SettingAnchor>
                    {customProvider.apiKey ? (
                        <Item
                            testID="memory-settings-embeddings-openai-api-key-remove"
                            title={t('memorySearchSettings.embeddings.openAi.removeApiKey')}
                            showChevron={false}
                            onPress={() => {
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    custom: { ...customProvider, apiKey: null },
                                });
                            }}
                        />
                    ) : null}
                    <SettingAnchor setting={MEMORY_SETTINGS.settings.dimensions}>
                        <FieldValueItem
                            testID="memory-settings-embeddings-openai-dimensions"
                            fieldTestID="memory-settings-embeddings-openai-dimensions-field"
                            title={t('memorySearchSettings.embeddings.openAi.dimensionsTitle')}
                            subtitle={t('memorySearchSettings.embeddings.openAi.dimensionsPromptBody')}
                            placeholder={t('memorySearchSettings.embeddings.notSet')}
                            kind="integer"
                            allowEmpty
                            value={customProvider.dimensions == null ? '' : String(customProvider.dimensions)}
                            onCommit={(draft) => {
                                const dimensions = parseOptionalInteger(draft);
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    custom: { ...customProvider, dimensions },
                                });
                                return dimensions == null ? '' : String(dimensions);
                            }}
                        />
                    </SettingAnchor>
                </>
            ) : null}

            <SettingAnchor setting={MEMORY_SETTINGS.settings.textWeight}>
                <FieldValueItem
                    testID="memory-settings-embeddings-fts-weight"
                    fieldTestID="memory-settings-embeddings-fts-weight-field"
                    title={t('memorySearchSettings.embeddings.advanced.ftsWeightTitle')}
                    subtitle={t('memorySearchSettings.embeddings.advanced.ftsWeightPromptBody')}
                    kind="decimal"
                    value={String(embeddings.blend.ftsWeight)}
                    onCommit={(draft) => {
                        const parsed = Number(draft);
                        if (!Number.isFinite(parsed)) return String(embeddings.blend.ftsWeight);
                        const ftsWeight = Math.max(0, Math.min(10, parsed));
                        updateEmbeddings(settings, props.writeSettings, {
                            ...embeddings,
                            blend: { ...embeddings.blend, ftsWeight },
                        });
                        return String(ftsWeight);
                    }}
                />
            </SettingAnchor>
            <SettingAnchor setting={MEMORY_SETTINGS.settings.embeddingWeight}>
                <FieldValueItem
                    testID="memory-settings-embeddings-embedding-weight"
                    fieldTestID="memory-settings-embeddings-embedding-weight-field"
                    title={t('memorySearchSettings.embeddings.advanced.embeddingWeightTitle')}
                    subtitle={t('memorySearchSettings.embeddings.advanced.embeddingWeightPromptBody')}
                    kind="decimal"
                    value={String(embeddings.blend.embeddingWeight)}
                    onCommit={(draft) => {
                        const parsed = Number(draft);
                        if (!Number.isFinite(parsed)) return String(embeddings.blend.embeddingWeight);
                        const embeddingWeight = Math.max(0, Math.min(10, parsed));
                        updateEmbeddings(settings, props.writeSettings, {
                            ...embeddings,
                            blend: { ...embeddings.blend, embeddingWeight },
                        });
                        return String(embeddingWeight);
                    }}
                />
            </SettingAnchor>
        </ItemGroup>
        </SettingSection>
    );
});
