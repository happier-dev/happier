import * as React from 'react';
import type { BotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { BotTemplateSetupSelectionsV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { projectBotTemplateSoftwareFactsV1 } from '@happier-dev/protocol/bots/templates/botTemplateOperations';
import { MachineSetupPlanResultV1Schema, type MachineSetupPlanResultV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { resolveEffectiveInputFields, seedInputByFieldHints } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import type { PluginProjectedMachineRecipeEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { useMachineField } from '@/sync/store/hooks';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { t } from '@/text';

type Software = BotTemplateSetupSelectionsV1['software'];
type Props = Readonly<{
    needs: BotTemplateContentV1['needs']['software'];
    value: Software;
    onChange: (value: Software) => void;
    machineId: string | null;
    machineOnline: boolean | null;
    serverId: string;
    execution: ReturnType<typeof useMountedActionExecution>;
    onValidityChange?: (valid: boolean) => void;
    onInstallSummaryChange?: (summary: string) => void;
}>;

/** Reads facts for the selected Machine; Create owns the one merged setup effect. */
export function BotTemplateSoftwareSetup(props: Props) {
    const { machineId, machineOnline, serverId, execution } = props;
    const homeId = resolvePortableServerIdentityForRoutingId(serverId);
    const observation = useMachineField(machineId ?? '', 'daemonState', 'setup', { serverId, enabled: Boolean(machineId) });
    const [catalog, setCatalog] = React.useState<Readonly<{ key: string; recipes: readonly PluginProjectedMachineRecipeEntryV1[] }> | null>(null);
    const latest = React.useRef({ props, catalog });
    latest.current = { props, catalog };
    // A field edit changes the reviewed operands, never the discovery demand.
    const catalogKey = JSON.stringify([execution.binding?.scope, execution.binding?.revision, serverId, homeId, machineId,
        props.needs.map(need => need.recipe)]);
    const demandKey = JSON.stringify([catalogKey, machineOnline]);
    const demand = React.useMemo(() => ({ key: demandKey, refs: props.needs.map(need => need.recipe) }), [demandKey]);
    // A recipe declaration remains useful while asleep; native installed facts do not.
    const recipes = catalog?.key === catalogKey ? catalog.recipes : [];
    const recipeFor = (need: Props['needs'][number]) => recipes.find(recipe => recipe.pluginId === need.recipe.pluginId
        && recipe.definition.id === need.recipe.recipeId && recipe.definition.revision === need.recipe.revision);
    const [planned, setPlanned] = React.useState<Readonly<{ key: string; plan: MachineSetupPlanResultV1 | null }> | null>(null);
    React.useEffect(() => {
        if (!homeId || !machineId || machineOnline !== true || !props.needs.length || !execution.ready) return;
        const controller = new AbortController();
        void (async () => {
            const details = await execution.execute('action.options.resolve', { actionId: 'machines.setup.plan',
                fieldPath: 'sources.0.setup.items.0.selection.ref', draftInput: { homeId, machineId }, values: demand.refs },
            { signal: controller.signal });
            if (controller.signal.aborted) return;
            const parsedDetails = details.ok ? PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].safeParse(details.result) : null;
            const entries = parsedDetails?.success ? parsedDetails.data.machineRecipeDetails ?? [] : [];
            const { props: current, catalog: previousCatalog } = latest.current;
            // An Install chosen before its declaration arrives still receives the
            // canonical initial defaults; subsequent edits remain authoritative.
            const seeded = current.value.map(choice => {
                if (choice.selection.action !== 'install') return choice;
                const need = current.needs.find(need => need.key === choice.key);
                const recipe = need && entries.find(recipe => recipe.pluginId === need.recipe.pluginId
                    && recipe.definition.id === need.recipe.recipeId && recipe.definition.revision === need.recipe.revision);
                if (!recipe || previousCatalog?.key === catalogKey && previousCatalog.recipes.some(previous =>
                    previous.id === recipe.id && previous.definition.revision === recipe.definition.revision)) return choice;
                const inputs = recipeInputs(recipe, choice.selection.inputs);
                return sameStrictJsonValue(inputs, choice.selection.inputs) ? choice
                    : { ...choice, selection: { action: 'install' as const, inputs } };
            });
            if (!sameStrictJsonValue(seeded, current.value)) current.onChange(seeded);
            setCatalog({ key: catalogKey, recipes: entries });
            const sources = [{ kind: 'direct', setup: { items: demand.refs.map(ref => ({ kind: 'softwareRecipe', selection: { ref,
                inputs: recipeInputs(entries.find(recipe => recipe.pluginId === ref.pluginId && recipe.definition.id === ref.recipeId
                    && recipe.definition.revision === ref.revision)),
            } })) } }];
            const result = await execution.execute('machines.setup.plan', { homeId, machineId, mode: 'effects', sources },
                { signal: controller.signal });
            if (controller.signal.aborted) return;
            const parsed = result.ok ? MachineSetupPlanResultV1Schema.safeParse(result.result) : null;
            setPlanned({ key: demand.key, plan: parsed?.success ? parsed.data : null });
        })().catch(() => {
            if (!controller.signal.aborted) setPlanned({ key: demand.key, plan: null });
        });
        return () => controller.abort();
    }, [catalogKey, demand, execution.execute, execution.ready, homeId, machineId, machineOnline]);
    const facts = projectBotTemplateSoftwareFactsV1(props.needs, machineOnline === true ? observation ?? null : null,
        machineOnline === true && planned?.key === demand.key ? planned.plan : null);
    const installSummary = props.needs.filter(need => facts.find(fact => fact.key === need.key)?.status !== 'found'
        && props.value.find(choice => choice.key === need.key)?.selection.action === 'install').map(need => need.name).join(', ');
    React.useEffect(() => { props.onInstallSummaryChange?.(installSummary); }, [props.onInstallSummaryChange, installSummary]);
    const change = (key: string, selection: Software[number]['selection']) => props.onChange([
        ...props.value.filter(choice => choice.key !== key), { key, selection },
    ]);
    const automatic = props.needs.flatMap(need => {
        if (facts.find(fact => fact.key === need.key)?.status !== 'found'
            || props.value.find(choice => choice.key === need.key)?.selection.action === 'install') return [];
        const recipe = recipeFor(need);
        return [{ key: need.key, selection: { action: 'install' as const, inputs: recipeInputs(recipe) } }];
    });
    const automaticKey = JSON.stringify(automatic);
    React.useEffect(() => {
        if (automatic.length) props.onChange([...props.value.filter(choice => !automatic.some(next => next.key === choice.key)), ...automatic]);
    }, [automaticKey, props.onChange, props.value]);
    const valid = props.value.every(choice => {
        if (choice.selection.action !== 'install') return true;
        const need = props.needs.find(need => need.key === choice.key);
        const recipe = need && recipeFor(need);
        return !recipe || createPluginJsonSchemaZodValueAdapter(recipe.definition.inputSchema).safeParse(choice.selection.inputs).success;
    });
    React.useEffect(() => { props.onValidityChange?.(valid); }, [props.onValidityChange, valid]);
    if (!props.needs.length) return null;
    return <ItemGroup title={t('botTemplates.software')}>
        {props.needs.map(need => {
            const fact = facts.find(fact => fact.key === need.key)!;
            const selected = props.value.find(choice => choice.key === need.key)?.selection;
            const recipe = recipeFor(need);
            const title = need.name;
            const status = fact.status === 'found'
                ? [t('botTemplateRecipient.softwareFound'), ...fact.versions].join(' · ')
                : fact.status === 'missing' ? t('botTemplateRecipient.softwareMissing')
                : machineOnline !== true ? t('botTemplateRecipient.softwareUnknown')
                : planned?.key === demand.key ? t('botTemplateRecipient.softwareCheckUnavailable')
                : t('botTemplateRecipient.softwareChecking');
            return <React.Fragment key={need.key}>
                {fact.status === 'found' ? <Item testID={`bot-template-software-${need.key}`} title={title}
                    subtitle={status} mode="info" showChevron={false} />
                    : <SegmentedChoiceItem testIDPrefix={`bot-template-software-${need.key}`} title={title}
                        subtitle={[status, need.requirement === 'optional' ? need.skipConsequence : ''].filter(Boolean).join(' · ')}
                        subtitleLines={0} value={selected?.action ?? ''} options={[
                            { id: 'install', label: t('botTemplateRecipient.installSoftware') },
                            { id: 'skip', label: t('botTemplateRecipient.skipNeed'), description: need.skipConsequence,
                                disabled: need.requirement === 'required',
                                ...(need.requirement === 'required' ? { unavailableReason: t('botTemplateRecipient.required') } : {}) },
                        ]} onChange={action => {
                            if (action === selected?.action) return;
                            if (action === 'skip' && need.requirement !== 'required') change(need.key, { action: 'skip' });
                            if (action === 'install') change(need.key, { action: 'install', inputs: recipeInputs(recipe) });
                        }} />}
                {selected?.action === 'install' && recipe ? <SoftwareInputs recipe={recipe} inputs={selected.inputs}
                    needKey={need.key} onChange={inputs => change(need.key, { action: 'install', inputs })} /> : null}
            </React.Fragment>;
        })}
    </ItemGroup>;
}

function recipeInputs(recipe: PluginProjectedMachineRecipeEntryV1 | undefined,
    current: Extract<Software[number]['selection'], { action: 'install' }>['inputs'] = {}) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return current;
    const inputHints = recipe && normalizePluginActionInputHintsV2(recipe.definition.inputHints, recipe.definition.inputSchema);
    return PluginJsonValueV2Schema.parse(seedInputByFieldHints({ inputHints }, current));
}

function SoftwareInputs(props: Readonly<{ recipe: PluginProjectedMachineRecipeEntryV1; inputs: Extract<Software[number]['selection'], { action: 'install' }>['inputs'];
    needKey: string; onChange: (inputs: Extract<Software[number]['selection'], { action: 'install' }>['inputs']) => void }>) {
    const inputHints = normalizePluginActionInputHintsV2(props.recipe.definition.inputHints, props.recipe.definition.inputSchema);
    const input = typeof props.inputs === 'object' && props.inputs !== null && !Array.isArray(props.inputs) ? props.inputs : {};
    const fields = resolveEffectiveInputFields({ inputHints }, input);
    if (!fields.length) return null;
    return <SectionContentRow><ActionInputFields fields={fields} input={input} editable resolveFieldOptions={field => field.options ?? []}
        resolveFieldTestID={field => `bot-template-software-${props.needKey}-input-${field.path}`}
        onPatch={patch => {
            const next = PluginJsonValueV2Schema.parse({ ...input, ...patch });
            if (!sameStrictJsonValue(next, props.inputs)) props.onChange(next);
        }} /></SectionContentRow>;
}
