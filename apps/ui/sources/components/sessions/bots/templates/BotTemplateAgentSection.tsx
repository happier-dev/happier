import * as React from 'react';
import { botTemplateEditorStyles as styles } from './botTemplateEditorStyles';
import { AGENT_IDS } from '@/agents/catalog/catalog';
import { getResolvedAgentCatalogEntries, resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useSessionSelector } from '@/sync/store/hooks';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { InlineTextField } from '@/components/ui/text/InlineTextField';
import { t } from '@/text';
import { useBotTemplateEditorValue } from './useBotTemplateEditor';
import type { BotTemplateEditorBuffer, BotTemplateSave } from './botTemplateEditorBuffer';

export function BotTemplateAgentSection({ buffer, save }: Readonly<{ buffer: BotTemplateEditorBuffer; save: BotTemplateSave }>) {
    const suggestion = useBotTemplateEditorValue(buffer, state => state.draft.content.suggestedAgent);
    const [open, setOpen] = React.useState(false);
    const source = buffer.getSnapshot().draft.sourceSessionRef;
    const machineId = useSessionSelector(source.sessionId, source.serverId,
        session => session ? readSessionOwnerMetadataView(session)?.machineId ?? null : null);
    const catalog = useDaemonMergedProjectionInputs({ machineId, serverId: source.serverId, enabled: open, sections: ['agentsById'] });
    const entries = open ? getResolvedAgentCatalogEntries({ enabledAgentIds: AGENT_IDS,
        mergedBackendProjectionById: catalog.inputs?.mergedBackendProjectionById,
        mergedProviderProjectionById: catalog.inputs?.mergedProviderProjectionById }) : [];
    const items = [{ id: '', title: t('botTemplates.chooseAgent') }, ...entries.map(entry => ({ id: entry.agentId, title: entry.title }))];
    if (suggestion && !items.some(item => item.id === suggestion.agentId)) items.push({ id: suggestion.agentId,
        title: resolveAgentCatalogProjection(suggestion.agentId, { enabledAgentIds: AGENT_IDS,
            mergedBackendProjectionById: catalog.inputs?.mergedBackendProjectionById,
            mergedProviderProjectionById: catalog.inputs?.mergedProviderProjectionById }).title });
    return <ItemGroup title={t('botTemplates.suggestedAgent')}>
        <DropdownMenu testID="bot-template-agent" open={open} onOpenChange={setOpen} items={items} selectedId={suggestion?.agentId ?? ''}
            itemTrigger={{ title: t('botTemplates.suggestedAgent'), itemProps: { testID: 'bot-template-agent-trigger' } }} onSelect={agentId => {
                buffer.edit(draft => {
                    const { suggestedAgent: _previous, ...content } = draft.content;
                    return { ...draft, content: { ...content, ...(agentId ? { suggestedAgent: { agentId } } : {}) } };
                });
                void buffer.commit(save);
            }} />
        {suggestion ? <Item title={t('botTemplates.modelSuggestion')} rightElement={<InlineTextField style={styles.field} editor={{
            value: suggestion.modelId ?? '', placeholder: t('botTemplates.modelSuggestion'), accessibilityLabel: t('botTemplates.modelSuggestion'),
            testID: 'bot-template-model', onChangeText: modelId => buffer.edit(draft => ({ ...draft,
                content: { ...draft.content, suggestedAgent: { agentId: suggestion.agentId, ...(modelId ? { modelId } : {}) } } })),
            onCommit: () => { void buffer.commit(save); },
        }} />} /> : null}
    </ItemGroup>;
}
