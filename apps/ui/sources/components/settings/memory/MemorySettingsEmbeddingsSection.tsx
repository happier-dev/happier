import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import type { SecretString } from '@/sync/encryption/secretSettings';
import { t } from '@/text';

import {
    MemoryEmbeddingsLocalTransformersConfigSchema,
    MemoryEmbeddingsOpenAiCompatibleConfigSchema,
    type MemorySettingsV1,
} from '@happier-dev/protocol';

function normalizeSecretStringPromptInput(value: string | null): SecretString | null {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? { _isSecretValue: true, value: trimmed } : null;
}

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
    const { theme } = useUnistyles();
    const { settings } = props;
    const [modeMenuOpen, setModeMenuOpen] = React.useState(false);
    const [providerMenuOpen, setProviderMenuOpen] = React.useState(false);

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
        <ItemGroup
            title={t('memorySearchSettings.embeddings.groupTitle')}
            footer={t('memorySearchSettings.embeddings.groupFooter')}
        >
            <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                <DropdownMenu
                    open={modeMenuOpen}
                    onOpenChange={setModeMenuOpen}
                    selectedId={getEmbeddingsModeOptionId(embeddings)}
                    search={false}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('memorySearchSettings.embeddings.mode.title'),
                        subtitle: modeSubtitle,
                        icon: <Ionicons name="sparkles-outline" size={29} color={theme.colors.state.success.foreground} />,
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
            </View>

            {embeddings.mode === 'custom' ? (
                <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                    <DropdownMenu
                        open={providerMenuOpen}
                        onOpenChange={setProviderMenuOpen}
                        selectedId={customProvider?.kind ?? 'local_transformers'}
                        search={false}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        itemTrigger={{
                            title: t('memorySearchSettings.embeddings.provider.title'),
                            subtitle: customProvider?.kind === 'openai_compatible'
                                ? t('memorySearchSettings.embeddings.provider.options.openAiCompatibleSubtitle')
                                : t('memorySearchSettings.embeddings.provider.options.localSubtitle'),
                            icon: <Ionicons name="cloud-outline" size={29} color={theme.colors.accent.blue} />,
                            itemProps: {
                                testID: 'memory-settings-embeddings-provider',
                            },
                        }}
                        items={[
                            {
                                id: 'local_transformers',
                                title: t('memorySearchSettings.embeddings.provider.options.localTitle'),
                                subtitle: t('memorySearchSettings.embeddings.provider.options.localSubtitle'),
                            },
                            {
                                id: 'openai_compatible',
                                title: t('memorySearchSettings.embeddings.provider.options.openAiCompatibleTitle'),
                                subtitle: t('memorySearchSettings.embeddings.provider.options.openAiCompatibleSubtitle'),
                            },
                        ]}
                        onSelect={(id) => {
                            setProviderMenuOpen(false);
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
                </View>
            ) : null}

            {customProvider?.kind === 'local_transformers' ? (
                <>
                    <Item
                        testID="memory-settings-embeddings-local-model"
                        title={t('memorySearchSettings.embeddings.modelTitle')}
                        subtitle={customProvider.modelId}
                        icon={<Ionicons name="cube-outline" size={29} color={theme.colors.accent.purple} />}
                        onPress={async () => {
                            const next = await Modal.prompt(
                                t('memorySearchSettings.embeddings.modelTitle'),
                                t('memorySearchSettings.embeddings.promptBody'),
                                {
                                    defaultValue: customProvider.modelId,
                                    placeholder: t('memorySearchSettings.embeddings.modelPlaceholder'),
                                    confirmText: t('common.save'),
                                    cancelText: t('common.cancel'),
                                },
                            );
                            if (typeof next === 'string' && next.trim()) {
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    custom: { ...customProvider, modelId: next.trim() },
                                });
                            }
                        }}
                        showChevron={false}
                    />
                    <Item
                        testID="memory-settings-embeddings-local-query-prefix"
                        title={t('memorySearchSettings.embeddings.queryPrefixTitle')}
                        subtitle={customProvider.queryPrefix ?? t('memorySearchSettings.embeddings.notSet')}
                        icon={<Ionicons name="search-outline" size={29} color={theme.colors.text.secondary} />}
                        onPress={async () => {
                            const next = await Modal.prompt(
                                t('memorySearchSettings.embeddings.queryPrefixTitle'),
                                t('memorySearchSettings.embeddings.queryPrefixPromptBody'),
                                { defaultValue: customProvider.queryPrefix ?? '' },
                            );
                            if (next === null) return;
                            updateEmbeddings(settings, props.writeSettings, {
                                ...embeddings,
                                custom: { ...customProvider, queryPrefix: next.trim() || null },
                            });
                        }}
                        showChevron={false}
                    />
                    <Item
                        testID="memory-settings-embeddings-local-document-prefix"
                        title={t('memorySearchSettings.embeddings.documentPrefixTitle')}
                        subtitle={customProvider.documentPrefix ?? t('memorySearchSettings.embeddings.notSet')}
                        icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.text.secondary} />}
                        onPress={async () => {
                            const next = await Modal.prompt(
                                t('memorySearchSettings.embeddings.documentPrefixTitle'),
                                t('memorySearchSettings.embeddings.documentPrefixPromptBody'),
                                { defaultValue: customProvider.documentPrefix ?? '' },
                            );
                            if (next === null) return;
                            updateEmbeddings(settings, props.writeSettings, {
                                ...embeddings,
                                custom: { ...customProvider, documentPrefix: next.trim() || null },
                            });
                        }}
                        showChevron={false}
                    />
                </>
            ) : null}

            {customProvider?.kind === 'openai_compatible' ? (
                <>
                    <Item
                        testID="memory-settings-embeddings-openai-base-url"
                        title={t('memorySearchSettings.embeddings.openAi.baseUrlTitle')}
                        subtitle={customProvider.baseUrl ?? t('memorySearchSettings.embeddings.notSet')}
                        icon={<Ionicons name="link-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={async () => {
                            const next = await Modal.prompt(
                                t('memorySearchSettings.embeddings.openAi.baseUrlTitle'),
                                t('memorySearchSettings.embeddings.openAi.baseUrlPromptBody'),
                                { defaultValue: customProvider.baseUrl ?? '' },
                            );
                            if (next === null) return;
                            updateEmbeddings(settings, props.writeSettings, {
                                ...embeddings,
                                custom: { ...customProvider, baseUrl: next.trim() || null },
                            });
                        }}
                        showChevron={false}
                    />
                    <Item
                        testID="memory-settings-embeddings-openai-model"
                        title={t('memorySearchSettings.embeddings.openAi.modelTitle')}
                        subtitle={customProvider.model}
                        icon={<Ionicons name="cube-outline" size={29} color={theme.colors.accent.purple} />}
                        onPress={async () => {
                            const next = await Modal.prompt(
                                t('memorySearchSettings.embeddings.openAi.modelTitle'),
                                t('memorySearchSettings.embeddings.openAi.modelPromptBody'),
                                { defaultValue: customProvider.model },
                            );
                            if (typeof next === 'string' && next.trim()) {
                                updateEmbeddings(settings, props.writeSettings, {
                                    ...embeddings,
                                    custom: { ...customProvider, model: next.trim() },
                                });
                            }
                        }}
                        showChevron={false}
                    />
                    <Item
                        testID="memory-settings-embeddings-openai-api-key"
                        title={t('memorySearchSettings.embeddings.openAi.apiKeyTitle')}
                        subtitle={customProvider.apiKey ? t('memorySearchSettings.embeddings.secretSet') : t('memorySearchSettings.embeddings.secretNotSet')}
                        icon={<Ionicons name="key-outline" size={29} color={theme.colors.state.neutral.foreground} />}
                        onPress={async () => {
                            const next = await Modal.prompt(
                                t('memorySearchSettings.embeddings.openAi.apiKeyTitle'),
                                t('memorySearchSettings.embeddings.openAi.apiKeyPromptBody'),
                                { inputType: 'secure-text' },
                            );
                            if (next === null) return;
                            updateEmbeddings(settings, props.writeSettings, {
                                ...embeddings,
                                custom: { ...customProvider, apiKey: normalizeSecretStringPromptInput(next) },
                            });
                        }}
                        showChevron={false}
                    />
                    <Item
                        testID="memory-settings-embeddings-openai-dimensions"
                        title={t('memorySearchSettings.embeddings.openAi.dimensionsTitle')}
                        subtitle={customProvider.dimensions == null
                            ? t('memorySearchSettings.embeddings.notSet')
                            : String(customProvider.dimensions)}
                        icon={<Ionicons name="resize-outline" size={29} color={theme.colors.text.secondary} />}
                        onPress={async () => {
                            const next = await Modal.prompt(
                                t('memorySearchSettings.embeddings.openAi.dimensionsTitle'),
                                t('memorySearchSettings.embeddings.openAi.dimensionsPromptBody'),
                                { defaultValue: customProvider.dimensions == null ? '' : String(customProvider.dimensions) },
                            );
                            if (next === null) return;
                            updateEmbeddings(settings, props.writeSettings, {
                                ...embeddings,
                                custom: { ...customProvider, dimensions: parseOptionalInteger(next) },
                            });
                        }}
                        showChevron={false}
                    />
                </>
            ) : null}

            <Item
                testID="memory-settings-embeddings-fts-weight"
                title={t('memorySearchSettings.embeddings.advanced.ftsWeightTitle')}
                subtitle={String(embeddings.blend.ftsWeight)}
                icon={<Ionicons name="analytics-outline" size={29} color={theme.colors.text.secondary} />}
                onPress={async () => {
                    const next = await Modal.prompt(
                        t('memorySearchSettings.embeddings.advanced.ftsWeightTitle'),
                        t('memorySearchSettings.embeddings.advanced.ftsWeightPromptBody'),
                        { defaultValue: String(embeddings.blend.ftsWeight) },
                    );
                    if (next === null) return;
                    const parsed = Number(next);
                    if (!Number.isFinite(parsed)) return;
                    updateEmbeddings(settings, props.writeSettings, {
                        ...embeddings,
                        blend: { ...embeddings.blend, ftsWeight: Math.max(0, Math.min(10, parsed)) },
                    });
                }}
                showChevron={false}
            />
            <Item
                testID="memory-settings-embeddings-embedding-weight"
                title={t('memorySearchSettings.embeddings.advanced.embeddingWeightTitle')}
                subtitle={String(embeddings.blend.embeddingWeight)}
                icon={<Ionicons name="git-network-outline" size={29} color={theme.colors.text.secondary} />}
                onPress={async () => {
                    const next = await Modal.prompt(
                        t('memorySearchSettings.embeddings.advanced.embeddingWeightTitle'),
                        t('memorySearchSettings.embeddings.advanced.embeddingWeightPromptBody'),
                        { defaultValue: String(embeddings.blend.embeddingWeight) },
                    );
                    if (next === null) return;
                    const parsed = Number(next);
                    if (!Number.isFinite(parsed)) return;
                    updateEmbeddings(settings, props.writeSettings, {
                        ...embeddings,
                        blend: { ...embeddings.blend, embeddingWeight: Math.max(0, Math.min(10, parsed)) },
                    });
                }}
                showChevron={false}
            />
        </ItemGroup>
    );
});
