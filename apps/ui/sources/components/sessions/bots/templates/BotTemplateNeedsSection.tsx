import * as React from 'react';
import { botTemplateEditorStyles as styles } from './botTemplateEditorStyles';
import { BotTemplateSoftwareNeedV1Schema, BotTemplateAccountNeedV1Schema, BotTemplateMcpNeedV1Schema,
    type BotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { projectBotTemplateMcpDefinitionV1, type BotTemplateMcpDefinitionV1 } from '@happier-dev/protocol/mcp/servers/portableMcpDefinitionV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { useAppShellPluginUiDeclarationSources, useProjectedConnectedServicesRegistry, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveConnectedServiceRegistryEntryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { InlineTextField } from '@/components/ui/text/InlineTextField';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { randomUUID } from '@/platform/randomUUID';
import { useSessionSelector } from '@/sync/store/hooks';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { t } from '@/text';
import { useBotTemplateEditorValue } from './useBotTemplateEditor';
import type { BotTemplateEditorBuffer, BotTemplateSave } from './botTemplateEditorBuffer';

type Needs = BotTemplateContentV1['needs'];
type NeedKind = keyof Needs;
type Need = Needs[NeedKind][number];
type Props = Readonly<{ buffer: BotTemplateEditorBuffer; save: BotTemplateSave; scope: ServerAccountScope }>;

export function BotTemplateNeedsSection(props: Props) {
    const keyList = useBotTemplateEditorValue(props.buffer, state => JSON.stringify(Object.entries(state.draft.content.needs)
        .flatMap(([kind, needs]) => needs.map(need => ({ kind, key: need.key })))));
    const keys = React.useMemo(() => JSON.parse(keyList) as { kind: NeedKind; key: string }[], [keyList]);
    const adding = useBotTemplateEditorValue(props.buffer, state => state.needAuthoring.open);
    return <ItemGroup title={t('botTemplateRecipient.needs')} description={t('botTemplates.needsDescription')}
        action={<SectionActionButton title={t('common.add')} icon="plus" testID="bot-template-need-add" expanded={adding}
            onPress={() => props.buffer.editNeedAuthoring({ open: !adding })} />}>
        {keys.map(need => <NeedEditor key={`${need.kind}:${need.key}`} {...props} kind={need.kind} needKey={need.key} />)}
        {!adding && !keys.length ? <SectionContentRow><Text variant="meta">{t('botTemplates.noNeeds')}</Text></SectionContentRow> : null}
        {adding ? <AddNeed {...props} /> : null}
    </ItemGroup>;
}

function changeNeed(draft: ReturnType<BotTemplateEditorBuffer['getSnapshot']>['draft'], kind: NeedKind, key: string, change: Partial<Pick<Need, 'name' | 'purpose' | 'skipConsequence' | 'requirement'>>) {
    return { ...draft, content: { ...draft.content, needs: { ...draft.content.needs,
        [kind]: draft.content.needs[kind].map(item => item.key === key ? { ...item, ...change } : item) } } };
}

function NeedEditor(props: Props & Readonly<{ kind: NeedKind; needKey: string }>) {
    const need = useBotTemplateEditorValue(props.buffer, state => state.draft.content.needs[props.kind].find(item => item.key === props.needKey));
    const [expanded, setExpanded] = React.useState(false);
    if (!need) return null;
    const commit = () => { void props.buffer.commit(props.save); };
    return <ExpandableItem expanded={expanded} onExpandedChange={setExpanded} header={({ headerProps }) =>
        <Item {...headerProps} title={need.name} subtitle={need.purpose}
            detail={t(need.requirement === 'required' ? 'botTemplateRecipient.required' : 'botTemplateRecipient.optional')}
            testID={`bot-template-need:${props.kind}:${need.key}`} />}>
        {expanded ? <>
            <SegmentedChoiceItem title={t('botTemplates.requirement')} value={need.requirement}
                testIDPrefix={`bot-template-need-requirement:${need.key}`} options={[
                    { id: 'required', label: t('botTemplateRecipient.required') }, { id: 'optional', label: t('botTemplateRecipient.optional') },
                ]} onChange={requirement => { props.buffer.edit(draft => changeNeed(draft, props.kind, need.key, { requirement })); commit(); }} />
            {(['name', 'purpose', 'skipConsequence'] as const).map(field => <NeedText key={field} needKey={need.key} field={field} value={need[field]}
                onChange={value => props.buffer.edit(draft => changeNeed(draft, props.kind, need.key, { [field]: value }))} onCommit={commit} />)}
            {'recipe' in need ? <Item title={t('botTemplates.software')} subtitle={`${need.recipe.pluginId} · ${need.recipe.recipeId} · ${need.recipe.revision}`} showChevron={false} /> : null}
            {'serviceId' in need ? <Item title={t('botTemplates.accounts')} subtitle={need.serviceId} showChevron={false} /> : null}
            {'definition' in need ? <>
                <McpLiteralFields definition={need.definition} needKey={need.key} onChange={change => props.buffer.edit(draft => ({
                    ...draft, content: { ...draft.content, needs: { ...draft.content.needs,
                        mcpServers: draft.content.needs.mcpServers.map(item => item.key === need.key ? { ...item, definition: change(item.definition) } : item),
                    } },
                }))} onCommit={commit} />
                <SectionContentRow><Text variant="meta">{t('botTemplates.mcpReview')}</Text>
                    <CodeBlockView code={JSON.stringify(need.definition, null, 2)} language="json" wrap />
                </SectionContentRow>
            </> : null}
            <SectionActionButton title={t('common.remove')} icon="minus" testID={`bot-template-need-remove:${need.key}`} onPress={() => {
                props.buffer.edit(draft => ({ ...draft, content: { ...draft.content, needs: { ...draft.content.needs,
                    [props.kind]: draft.content.needs[props.kind].filter(item => item.key !== need.key) } } })); commit();
            }} />
        </> : null}
    </ExpandableItem>;
}

function NeedText(props: Readonly<{ needKey: string; field: 'name' | 'purpose' | 'skipConsequence'; value: string; onChange: (value: string) => void; onCommit?: () => void }>) {
    const title = props.field === 'name' ? t('common.name') : t(props.field === 'purpose' ? 'botTemplates.purpose' : 'botTemplates.skipConsequence');
    return <Item title={title} accessoryLayout={props.field === 'name' ? 'adaptive' : 'stacked'} rightElement={<InlineTextField style={styles.field}
        multiline={props.field !== 'name'} editor={{ value: props.value, placeholder: title, accessibilityLabel: title,
            testID: `bot-template-need-field:${props.needKey}:${props.field}`, onChangeText: props.onChange, onCommit: props.onCommit }} />} />;
}

function McpLiteralFields(props: Readonly<{ definition: BotTemplateMcpDefinitionV1; needKey: string;
    onChange: (change: (definition: BotTemplateMcpDefinitionV1) => BotTemplateMcpDefinitionV1) => void; onCommit: () => void }>) {
    const stdio = props.definition.stdio;
    const remote = props.definition.remote;
    return <>
        {stdio?.command.kind === 'literal' ? <McpField label={t('botTemplates.command')} value={stdio.command.value}
            testID={`bot-template-mcp-literal:${props.needKey}:command`} onCommit={props.onCommit}
            onChange={value => props.onChange(definition => ({ ...definition, stdio: { ...definition.stdio!, command: { kind: 'literal', value } } }))} /> : null}
        {stdio && stdio.args.every(arg => arg.kind === 'literal') ? <McpField label={t('botTemplates.arguments')}
            value={stdio.args.map(arg => arg.kind === 'literal' ? arg.value : '').join('\n')} multiline
            testID={`bot-template-mcp-literal:${props.needKey}:arguments`} onCommit={props.onCommit}
            onChange={value => props.onChange(definition => ({ ...definition, stdio: { ...definition.stdio!,
                args: value ? value.split(/\r?\n/).map(value => ({ kind: 'literal', value })) : [] } }))} /> : null}
        {remote?.url.baseUrl.kind === 'literal' ? <McpField label={t('botTemplates.url')} value={remote.url.baseUrl.value}
            testID={`bot-template-mcp-literal:${props.needKey}:url`} onCommit={props.onCommit}
            onChange={value => props.onChange(definition => ({ ...definition, remote: { ...definition.remote!,
                url: { ...definition.remote!.url, baseUrl: { kind: 'literal', value } } } }))} /> : null}
    </>;
}

function AddNeed(props: Props) {
    const { kind, name, purpose, skipConsequence, selection, transport, endpoint, args, envNames, headerNames }
        = useBotTemplateEditorValue(props.buffer, state => state.needAuthoring);
    const [error, setError] = React.useState(false);
    const [open, setOpen] = React.useState(false);
    const [refreshKey, retryCatalog] = React.useReducer(value => value + 1, 0);
    const sources = useAppShellPluginUiDeclarationSources();
    const registry = useProjectedConnectedServicesRegistry();
    const localize = useProjectedPluginLocalizedTextResolver();
    const sameScope = areServerAccountScopesEqual(sources.accountLifetime?.scope, props.scope);
    const source = props.buffer.getSnapshot().draft.sourceSessionRef;
    const sourceMachineId = useSessionSelector(source.sessionId, source.serverId,
        session => session ? readSessionOwnerMetadataView(session)?.machineId ?? null : null);
    const recipeProjection = useDaemonMergedProjectionInputs({ machineId: sourceMachineId, serverId: source.serverId,
        enabled: kind === 'software', refreshKey, sections: ['familiesById.machineRecipes'] });
    const recipes = recipeProjection.phase === 'ready' ? Object.values(recipeProjection.inputs?.pluginUiProjection.machineRecipesById ?? {}) : [];
    const services = sameScope && sources.ready ? registry.entries : [];
    const items = kind === 'software' ? recipes.map(recipe => ({ id: recipe.id, title: localize(recipe.pluginId, recipe.definition.title) }))
        : services.map(service => ({ id: service.service ? buildQualifiedPluginContributionKey(service.service) : service.serviceId,
            title: resolveConnectedServiceRegistryEntryDisplayName(service, t, localize) }));
    const add = () => {
        const key = randomUUID();
        const common = { key, name: name.trim() || items.find(item => item.id === selection)?.title || '', requirement: 'required' as const, purpose, skipConsequence };
        let need: Need | undefined;
        if (kind === 'software') {
            const recipe = recipes.find(item => item.id === selection);
            const parsed = BotTemplateSoftwareNeedV1Schema.safeParse({ ...common, recipe: recipe ? {
                pluginId: recipe.pluginId, recipeId: recipe.definition.id, revision: recipe.definition.revision,
            } : undefined });
            if (parsed.success) need = parsed.data;
        } else if (kind === 'connectedAccounts') {
            const service = items.find(item => item.id === selection);
            const parsed = BotTemplateAccountNeedV1Schema.safeParse({ ...common, serviceId: service?.id });
            if (parsed.success) need = parsed.data;
        } else {
            const names = (text: string) => Object.fromEntries(text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
                .map(value => [value, { t: 'literal', v: '' }]));
            const source = McpServerCatalogEntryV1Schema.safeParse({ id: key, name: key, title: common.name, transport,
                ...(transport === 'stdio' ? { stdio: { command: endpoint, args: args ? args.split(/\r?\n/) : [] } }
                    : { remote: { url: endpoint, headers: names(headerNames) } }), env: names(envNames), createdAt: 0, updatedAt: 0 });
            if (source.success) {
                const parsed = BotTemplateMcpNeedV1Schema.safeParse({ ...common, definition: projectBotTemplateMcpDefinitionV1(source.data) });
                if (parsed.success) need = parsed.data;
            }
        }
        if (!need) { setError(true); return; }
        const admitted = need;
        props.buffer.edit(draft => ({ ...draft, content: { ...draft.content, needs: { ...draft.content.needs,
            [kind]: [...draft.content.needs[kind], admitted] } } }));
        void props.buffer.commit(props.save);
        props.buffer.resetNeedAuthoring();
    };
    return <>
        <SegmentedChoiceItem title={t('botTemplates.addNeed')} value={kind} testIDPrefix="bot-template-need-kind"
            onChange={kind => { props.buffer.editNeedAuthoring({ kind, selection: null }); setError(false); }}
            options={[{ id: 'software', label: t('botTemplates.software') }, { id: 'connectedAccounts', label: t('botTemplates.accounts') }, { id: 'mcpServers', label: t('botTemplates.mcp') }]} />
        {kind !== 'mcpServers' ? <DropdownMenu open={open} onOpenChange={setOpen} items={items} selectedId={selection}
            onSelect={selection => props.buffer.editNeedAuthoring({ selection })} search itemTrigger={{ title: t(kind === 'software' ? 'botTemplates.software' : 'botTemplates.accounts') }} /> : null}
        {kind !== 'mcpServers' && !items.length ? <SectionContentRow>
            {kind === 'software' && recipeProjection.phase === 'loading' || kind === 'connectedAccounts' && sameScope && !sources.ready
                ? <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />
                : <SurfaceStateCard size="line" testID="bot-template-need-catalog-unavailable"
                    kind={kind === 'software' && recipeProjection.phase !== 'ready' || kind === 'connectedAccounts' && !sameScope ? 'unavailable' : 'empty'}
                    title={t(kind === 'software' && recipeProjection.phase !== 'ready' || kind === 'connectedAccounts' && !sameScope
                        ? 'botTemplates.needsCatalogUnavailable' : 'botTemplates.needsCatalogEmpty')}
                    action={kind === 'software' && sourceMachineId && recipeProjection.phase === 'error'
                        ? { label: t('common.retry'), onPress: retryCatalog } : undefined} />}
        </SectionContentRow> : null}
        <NeedText needKey="new" field="name" value={name} onChange={name => props.buffer.editNeedAuthoring({ name })} />
        <NeedText needKey="new" field="purpose" value={purpose} onChange={purpose => props.buffer.editNeedAuthoring({ purpose })} />
        <NeedText needKey="new" field="skipConsequence" value={skipConsequence} onChange={skipConsequence => props.buffer.editNeedAuthoring({ skipConsequence })} />
        {kind === 'mcpServers' ? <>
            <SegmentedChoiceItem title={t('botTemplates.transport')} value={transport} onChange={transport => props.buffer.editNeedAuthoring({ transport })}
                options={Object.values(McpServerCatalogEntryV1Schema.shape.transport._zod.def.entries).map(value => ({ id: value, label: value }))} />
            <McpField label={t(transport === 'stdio' ? 'botTemplates.command' : 'botTemplates.url')} value={endpoint} onChange={endpoint => props.buffer.editNeedAuthoring({ endpoint })} testID="bot-template-mcp-endpoint" />
            {transport === 'stdio' ? <McpField label={t('botTemplates.arguments')} value={args} onChange={args => props.buffer.editNeedAuthoring({ args })} multiline testID="bot-template-mcp-arguments" />
                : <McpField label={t('botTemplates.headerNames')} value={headerNames} onChange={headerNames => props.buffer.editNeedAuthoring({ headerNames })} multiline testID="bot-template-mcp-headers" />}
            <McpField label={t('botTemplates.envNames')} value={envNames} onChange={envNames => props.buffer.editNeedAuthoring({ envNames })} multiline testID="bot-template-mcp-env" />
            <SectionContentRow><Text variant="meta">{t('botTemplates.mcpReview')}</Text></SectionContentRow>
        </> : null}
        {error ? <SectionContentRow><Text accessibilityLiveRegion="polite">{t('botTemplates.invalidNeed')}</Text></SectionContentRow> : null}
        <SectionContentRow><RoundButton title={t('common.add')} disabled={kind !== 'mcpServers' && !items.some(item => item.id === selection)} onPress={add} testID="bot-template-need-confirm" /></SectionContentRow>
    </>;
}

function McpField(props: Readonly<{ label: string; value: string; onChange: (value: string) => void; multiline?: boolean; testID?: string; onCommit?: () => void }>) {
    return <Item title={props.label} accessoryLayout={props.multiline ? 'stacked' : 'adaptive'} rightElement={<InlineTextField style={styles.field} multiline={props.multiline}
        editor={{ value: props.value, onChangeText: props.onChange, accessibilityLabel: props.label, placeholder: props.label,
            testID: props.testID, onCommit: props.onCommit }} />} />;
}
