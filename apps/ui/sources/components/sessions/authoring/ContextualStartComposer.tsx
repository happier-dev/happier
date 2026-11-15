import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_MENU_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import { useExecutableParticipantSections, executableParticipantOptionId } from '@/components/discussions/useExecutableParticipantSections';
import { useDiscussionWorkflowProject } from '@/components/discussions/useDiscussionWorkflowProject';
import { WorkflowProjectTargetControl } from '@/components/workflows/editor/WorkflowProjectTargetControl';
import { SelectionList, type SelectionListOption, type SelectionListSectionDescriptor, type SelectionListStep } from '@/components/ui/selectionList';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { AgentInputSelectionPopover } from '@/components/sessions/agentInput/selection/AgentInputSelectionPopover';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { getPermissionModeLabelForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { resolveExecutableModelParticipantDisplay, useExecutableParticipantLabel } from './useExecutableParticipantLabel';
import { t } from '@/text';

type WhoInput = Parameters<typeof useExecutableParticipantSections>[0];
export type ContextualStartComposerInput = WhoInput & Readonly<{
    /** A host-owned search field and the Who list share this query. */
    onQueryChange?: (query: string) => void;
    excludeSessionId?: string;
    selected: readonly ExecutableParticipantSelectionV1[];
    onReplace: (previous: ExecutableParticipantSelectionV1, next: ExecutableParticipantSelectionV1) => void;
    question: string;
    onQuestionChange: (question: string) => void;
    showWhere: boolean;
    onProject: (project: WorkflowProjectTargetV1 | null) => void;
    initialTarget?: WorkflowProjectTargetV1;
}>;

/** Discovery for the full participant flow. Run supplies its already-owned choices instead. */
export function useContextualStartParticipantSource(input: ContextualStartComposerInput) {
    const [query, setQuery] = React.useState('');
    const [readinessSessionId, setReadinessSessionId] = React.useState<string | null>(null);
    const who = useExecutableParticipantSections({ ...input, query: input.query ?? query, readinessSessionId,
        onReadinessSessionChange: setReadinessSessionId });
    const where = useDiscussionWorkflowProject(input.accountLifetime, input.enabled && input.showWhere, input.initialTarget);
    const { onProject } = input;
    React.useEffect(() => {
        if (input.enabled && input.showWhere) onProject(where.project);
    }, [input.enabled, input.showWhere, onProject, where.project]);
    const sections = React.useMemo(() => [...(who.peopleSection ? [who.peopleSection] : []), ...[...who.sections]
            .sort((a, b) => Number(a.id !== 'agents-models') - Number(b.id !== 'agents-models')).map(section => ({ ...section,
            options: section.options.filter(option => option.id !== `session:${input.excludeSessionId}`).map(option => ({ ...option,
                titleAccessory: option.titleAccessory ?? (option.id.startsWith('sessions:') ? undefined : <StatusPill variant="neutral" hideDot labelVariant="phrase"
                    label={t(section.id === 'agents-models' ? 'session.collaboration.discussion.participants.model'
                        : section.id === 'agents-bots' ? 'sessionsList.conditionBot' : 'session.collaboration.discussion.participants.session')} />),
                ...(option.id.startsWith('session:') ? { testID: `second-opinion.reviewer:${option.id.slice('session:'.length)}` } : {}),
            })),
        }))].map(section => ({ category: section.id === 'people' ? 'person' as const
            : section.id === 'agents-models' ? 'newAgent' as const
                : section.id === 'agents-bots' ? 'bot' as const : 'session' as const, section })),
    [input.excludeSessionId, who.peopleSection, who.sections]);
    const selectedIds = React.useMemo(() => new Set([
        ...input.selected.flatMap(selection => {
            const id = executableParticipantOptionId(selection);
            return id ? [id] : [];
        }),
        ...(input.people?.chosen.map(principal => principal.key) ?? []),
    ]), [input.people?.chosen, input.selected]);
    return {
        enabled: input.enabled, busy: input.busy,
        sections,
        selectedIds,
        participants: { input, who },
        search: { value: input.query ?? query, onChange: input.onQueryChange ?? setQuery },
        question: { value: input.question, onChange: input.onQuestionChange },
        where: input.showWhere ? { accountLifetime: input.accountLifetime, ...where, testIDPrefix: 'second-opinion' } : null,
    } satisfies ContextualStartSource;
}

export type ContextualStartAdmissibleSet = Readonly<{
    who: readonly ('newAgent' | 'session' | 'bot' | 'person')[];
    machine: 'select' | 'fixed';
    folder: 'select' | 'fixed';
}>;

export type ContextualStartSource = Readonly<{
    enabled: boolean;
    busy?: boolean;
    sections: readonly Readonly<{ category: ContextualStartAdmissibleSet['who'][number]; section: SelectionListSectionDescriptor }>[];
    selectedIds: ReadonlySet<string>;
    participants?: Readonly<{ input: ContextualStartComposerInput; who: ReturnType<typeof useExecutableParticipantSections> }>;
    search?: Readonly<{ value: string; onChange: (value: string) => void }>;
    question?: Readonly<{ value: string; onChange: (value: string) => void }>;
    where: (Pick<React.ComponentProps<typeof WorkflowProjectTargetControl>, 'accountLifetime' | 'target' | 'machineName' | 'machines' | 'machineHomeDir' | 'testIDPrefix'>
        & Readonly<{ choose?: React.ComponentProps<typeof WorkflowProjectTargetControl>['onChange'] }>) | null;
}>;

/** One admissibility decision and one presentation over the domain owner's supplied choices. */
export function useContextualStartComposer(source: ContextualStartSource, admissible: ContextualStartAdmissibleSet) {
    const rootStep = React.useMemo<SelectionListStep>(() => {
        const sections = source.sections.filter(entry => admissible.who.includes(entry.category)).map(entry => entry.section);
        return { id: 'contextual-start-who', sections,
            inputPlaceholder: sections.some(section => section.kind === 'dynamic')
                ? t('session.collaboration.discussion.manage.invitePlaceholder') : undefined,
        };
    }, [admissible.who, source.sections]);
    const where = source.where;
    const retained = React.useRef({ rootStep, target: where?.target, machineName: where?.machineName });
    React.useLayoutEffect(() => {
        if (source.enabled) retained.current = { rootStep, target: where?.target, machineName: where?.machineName };
    }, [source.enabled, rootStep, where?.target, where?.machineName]);
    const displayRoot = React.useMemo(() => {
        const current = source.enabled ? rootStep : retained.current.rootStep;
        return source.enabled && !source.busy ? current : ({ ...current,
        sections: current.sections.map(section => section.kind === 'static'
            ? { ...section, options: section.options.map(option => ({ ...option, disabled: true })) }
            : { ...section, resolve: async () => ({ options: [] }) }),
        });
    }, [source.busy, source.enabled, rootStep]);
    return { source, admissible, where: where && (source.enabled ? where : { ...where,
        target: retained.current.target, machineName: retained.current.machineName ?? null }),
        rootStep: displayRoot, selectedIds: source.selectedIds };
}

export type ContextualStartComposerModel = ReturnType<typeof useContextualStartComposer>;

/**
 * The folded Who list (lab flows `ask`): about four mixed top picks, so the question and what they can
 * read stay in reach without scrolling. Presentation only; the owner's ranking decides which ones.
 */
const WHO_PREVIEW = { total: 4, newAgent: 2, session: 1, bot: 1 } as const;

type ModelSelection = Extract<ExecutableParticipantSelectionV1, { kind: 'model' }>;

/**
 * Shared fields only; the host retains its existing admission controller and typed result adapter.
 * Lab dpRev: one Who list of what exists (Sessions, Bots, People, each naming its type); agents the
 * person adds lead it, checked, their recipe as the row's line with Change. "Add an agent" is the last
 * row and "+ Add agent" sits at the label's end; both open the same composer chips under the list.
 * Change opens that recipe there too and sets the question aside until it closes.
 */
export function ContextualStartComposerBody({ model, whoHint, question, whoContent, whoAccessory, details }: Readonly<{
    model: ContextualStartComposerModel;
    /** A quiet note at the Who label's trailing edge ("Pick two or more to run Fresh opinions"). */
    whoHint?: string | null;
    /** A host's rich draft editor occupies the same question position as the plain text field. */
    question?: React.ReactNode;
    whoContent?: React.ReactNode;
    whoAccessory?: Readonly<{ label: string; render: (close: () => void) => React.ReactNode }>;
    details?: ReadonlyMap<string, () => React.ReactNode>;
}>) {
    const { theme } = useUnistyles();
    const { source, where } = model;
    const { participants } = source;
    const busy = !source.enabled || source.busy === true;
    const [detailId, setDetailId] = React.useState<string | null>(null);
    const [accessoryOpen, setAccessoryOpen] = React.useState(false);
    const accessoryAnchorRef = React.useRef<View | null>(null);
    const closeAccessory = React.useCallback(() => setAccessoryOpen(false), []);
    const [expanded, setExpanded] = React.useState(false);
    const [whoEditing, setWhoEditing] = React.useState(() => source.selectedIds.size === 0);
    // Whether the open recipe adds an agent or changes a chosen one. Presentation only: the recipe
    // and its value stay with the participant owner.
    const [recipe, setRecipe] = React.useState<'add' | 'change' | null>(null);
    const editor = participants?.who.recipeEditor ?? null;
    const openRecipe = editor ? recipe : null;
    const onChoose = participants?.input.onChoose;
    const onReplace = participants?.input.onReplace;
    const editModel = participants?.who.editModel;
    const addAgent = model.admissible.who.includes('newAgent') ? participants?.who.addAgent ?? null : null;
    const startAdd = React.useCallback(() => { setRecipe('add'); addAgent?.(); }, [addAgent]);

    const display = React.useMemo(() => {
        const categoryOf = new Map(source.sections.map(entry => [entry.section.id, entry.category] as const));
        const agentSections = model.rootStep.sections.filter(section => categoryOf.get(section.id) !== 'person');
        const peopleSections = model.rootStep.sections.filter(section => categoryOf.get(section.id) === 'person');
        // Agents the person added have no row of their own in the list; they lead it.
        const added = (participants?.input.selected ?? []).filter((selection): selection is ModelSelection => selection.kind === 'model');
        const addRow: SelectionListOption | null = addAgent ? {
            id: 'who:add-agent', testID: 'contextual-start-add-agent',
            icon: <Icon name="plus" size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
            label: t('session.collaboration.discussion.secondOpinion.addAgent'),
            disabled: busy || openRecipe !== null, onSelect: startAdd,
        } : null;
        const addSection: SelectionListSectionDescriptor[] = addRow ? [{ kind: 'static', id: 'who:add', options: [addRow] }] : [];
        const decorate = (option: SelectionListOption): SelectionListOption => {
            const detail = details?.get(option.id);
            // A row that chooses nothing (an Agent not ready on the Machine) opens its detail itself: its setup.
            if (detail && !option.onSelect && !option.openStep) return { ...option,
                onSelect: () => setDetailId(current => current === option.id ? null : option.id) };
            if (detail) return { ...option, rightAccessoryOutsidePressable: true,
                rightAccessory: <TextLinkButton testID={`contextual-start-change:${option.id}`} tone="strong" size="meta"
                    label={t('common.change')} disabled={busy || option.disabled}
                    onPress={() => setDetailId(current => current === option.id ? null : option.id)} /> };
            return option;
        };
        const selectedIds = new Set(model.selectedIds);
        const isState = (option: SelectionListOption) => option.id.startsWith('sessions:');
        const candidates = agentSections.flatMap(section => section.kind === 'static'
            ? section.options.filter(option => !isState(option)).map(option => ({ option, category: categoryOf.get(section.id) ?? 'session' }))
            : []);
        const peopleChosen = (participants?.input.people?.chosen.length ?? 0) > 0;
        // A short list shows whole, people after it; only a longer one folds (people then wait inside Show all).
        const foldable = candidates.length > WHO_PREVIEW.total;
        if (expanded || !foldable) {
            // The type chip on every row names it, so the agent groups read as one list.
            const sections = agentSections.map(section => section.kind === 'static'
                ? { ...section, title: undefined, rightAccessory: undefined, count: undefined, options: section.options.map(decorate) }
                : section);
            return { step: { ...model.rootStep, sections: [...sections, ...peopleSections, ...addSection] }, selectedIds, added };
        }
        // Lab flows `ask`: a short mixed list of top picks. Whatever is chosen (or open) leads, then the
        // owner's first new agents, Session and Bot, in the order the owner already ranks them.
        const shown = new Set<string>();
        const top: SelectionListOption[] = [];
        const pinnedOf = new Map<string, number>();
        for (const { option, category } of candidates) {
            if (!selectedIds.has(option.id) && option.id !== detailId) continue;
            shown.add(option.id); top.push(option);
            pinnedOf.set(category, (pinnedOf.get(category) ?? 0) + 1);
        }
        // A chosen row counts toward its kind, so the picks stay mixed (lab: chosen model, model, Session, Bot).
        const take = (category: string, quota: number) => {
            let count = quota - (pinnedOf.get(category) ?? 0);
            for (const { option, category: kind } of candidates) {
                if (count <= 0 || top.length >= Math.max(WHO_PREVIEW.total, shown.size)) return;
                if (kind !== category || shown.has(option.id)) continue;
                shown.add(option.id); top.push(option); count -= 1;
            }
        };
        take('newAgent', WHO_PREVIEW.newAgent);
        take('session', WHO_PREVIEW.session);
        take('bot', WHO_PREVIEW.bot);
        // A kind with nothing to offer leaves its place to the next candidates in the owner's order.
        for (const { option } of candidates) {
            if (top.length >= WHO_PREVIEW.total) break;
            if (!shown.has(option.id)) { shown.add(option.id); top.push(option); }
        }
        const stateRows = agentSections.flatMap(section => section.kind === 'static'
            ? section.options.filter(option => isState(option) && option.id !== 'sessions:more') : []);
        const showAll: SelectionListOption = {
            id: 'who:show-all', testID: 'second-opinion.reviewers-more',
            // An empty mark slot, so the label shares the rows' title edge.
            icon: <View style={styles.markSlot} />,
            label: t('session.collaboration.discussion.secondOpinion.showAllReviewers', { count: candidates.length }),
            disabled: busy, onSelect: () => setExpanded(true),
        };
        const topSection: SelectionListSectionDescriptor = { kind: 'static', id: 'who:top',
            options: [...top.map(decorate), ...stateRows, showAll, ...(addRow ? [addRow] : [])] };
        // People live inside Show all; ones already chosen stay in sight.
        return { step: { ...model.rootStep, inputPlaceholder: peopleChosen ? model.rootStep.inputPlaceholder : undefined,
            sections: [topSection, ...(peopleChosen ? peopleSections : [])] }, selectedIds, added };
    }, [addAgent, busy, details, detailId, expanded, participants?.input.selected, participants?.input.people?.chosen, model.rootStep, model.selectedIds, openRecipe, source.sections, startAdd, theme.colors.text.secondary]);
    const chosenStep = React.useMemo<SelectionListStep>(() => ({
        ...display.step, inputPlaceholder: undefined,
        sections: display.step.sections.flatMap(section => {
            if (section.kind !== 'static') return [];
            const options = section.options.filter(option => display.selectedIds.has(option.id));
            return options.length > 0 ? [{ ...section, options }] : [];
        }),
    }), [display.step, display.selectedIds]);
    const hasChosen = chosenStep.sections.length > 0 || display.added.length > 0;
    const choosingWho = whoEditing || !hasChosen;
    const changing = openRecipe === 'change';
    // The recipe closes itself when it resolves; the mode follows it.
    React.useEffect(() => { if (editor === null) setRecipe(null); }, [editor]);

    return <View testID="contextual-start-composer" style={styles.root}>
        <View>
            <View style={[styles.groupRow, styles.hang]}>
                <CollectionListGroupLabel title={t('agentStart.chips.engineTitle')} presentation="menu" />
                {whoHint ? <Text style={styles.groupNote} numberOfLines={1}>{whoHint}</Text> : null}
                {hasChosen ? <TextLinkButton testID={`contextual-start-${choosingWho ? 'done' : 'change'}-who`}
                    tone="strong" size="meta" label={t(choosingWho ? 'common.done' : 'common.change')}
                    disabled={busy} onPress={() => setWhoEditing(value => !value)} /> : null}
                {/* The link holds its own start alignment; its wrapper joins the label's baseline. */}
                {whoAccessory ? <View ref={accessoryAnchorRef} collapsable={false}><TextLinkButton testID="contextual-start-who-accessory" tone="strong" size="meta"
                    label={whoAccessory.label} disabled={busy} onPress={() => setAccessoryOpen(value => !value)} /></View> : null}
                {addAgent ? <TextLinkButton testID="contextual-start-add-agent-button" tone="strong" size="meta"
                    label={t('session.collaboration.discussion.secondOpinion.addAgentShort')}
                    disabled={busy || openRecipe !== null} onPress={startAdd} /> : null}
            </View>
            {/* Agents the person added lead the list, checked, their recipe as the row's line (lab dpRev `two`). */}
            {display.added.map((selection, index) => <View key={index} style={styles.hang}>
                <AddedRecipeRow selection={selection} busy={busy} onPress={() => onChoose?.(selection)}
                    change={<TextLinkButton testID="second-opinion.change-model" tone="strong" size="meta"
                        label={t('common.change')} disabled={busy || openRecipe !== null}
                        onPress={() => { setRecipe('change'); editModel?.(selection, next => onReplace?.(selection, next)); }} />} />
            </View>)}
            <View style={styles.hang}>
                <SelectionList testID="contextual-start-who" rootStep={choosingWho ? display.step : chosenStep}
                    inputValue={choosingWho ? source.search?.value : undefined}
                    onChangeInputValue={choosingWho ? source.search?.onChange : undefined}
                    selection={{ kind: 'multiple', selectedIds: display.selectedIds }}
                    onSelect={() => undefined} onRequestClose={() => undefined}
                    listAccessibilityLabel={t('agentStart.chips.engineTitle')}
                    optionsHostInlineControls selectionMark="check" surface="none" disableTransitions
                />
            </View>
            {/* Add and Change open the recipe here, under the list; it never covers the form. */}
            {editor}
            {detailId ? details?.get(detailId)?.() : null}
            {whoAccessory ? <AgentInputSelectionPopover open={accessoryOpen} anchorRef={accessoryAnchorRef}
                onRequestClose={closeAccessory} accessibilityLabel={whoAccessory.label}>
                {({ maxHeight }) => <ScrollView style={{ maxHeight }} keyboardShouldPersistTaps="handled">
                    {whoAccessory.render(closeAccessory)}
                </ScrollView>}
            </AgentInputSelectionPopover> : null}
            {whoContent}
        </View>
        {changing ? null : question ?? (source.question ? <FieldItem label={<View style={styles.hang}>
            <CollectionListGroupLabel title={t('session.collaboration.discussion.secondOpinion.question')} presentation="menu" />
        </View>}>
            <FieldTextInput testID="second-opinion.question" value={source.question.value} onChangeText={source.question.onChange}
                editable={!busy}
                accessibilityLabel={t('session.collaboration.discussion.secondOpinion.question')} />
        </FieldItem> : null)}
        {where && !changing ? <WorkflowProjectTargetControl presentation="inline" accountLifetime={where.accountLifetime}
            target={where.target} machineName={where.machineName} machineHomeDir={where.machineHomeDir}
            machines={busy || model.admissible.machine === 'fixed' ? undefined : where.machines}
            directoryEditable={!busy && model.admissible.folder === 'select'}
            onChange={busy || model.admissible.folder === 'fixed' ? undefined : where.choose} testIDPrefix={where.testIDPrefix} /> : null}
    </View>;
}

/**
 * An added agent is a row like the Sessions under it (lab dpRev `two`): its Agent's mark in the icon column and its
 * name in the row's own title role, so it shares their edge and type.
 */
function AddedRecipeRow(props: Readonly<{ selection: ModelSelection; busy: boolean; onPress: () => void; change: React.ReactNode }>) {
    const { launch } = props.selection;
    const label = useExecutableParticipantLabel(props.selection, launch.executionTarget.serverId);
    const machines = useMachineListForServer(launch.executionTarget.serverId);
    const agentId = resolveExecutableModelParticipantDisplay(launch, machines ?? []).agentId ?? launch.agentTarget.identity.localId;
    return <Item testID="second-opinion.selected-model-row" density="compact" showChevron={false} showDivider={false}
        selected disabled={props.busy} title={label ?? t('session.collaboration.discussion.heldParticipant')}
        icon={<SessionAgentCatalogIdentityIcon agentId={agentId} machineId={launch.executionTarget.machineId}
            serverId={launch.executionTarget.serverId} size={ICON_SIZE.md} />}
        subtitle={<RecipeSummary selection={props.selection} />} onPress={props.onPress} rightElement={props.change} />;
}

/** A chosen recipe in one quiet line: model, Machine, folder and what it may do. */
function RecipeSummary(props: Readonly<{ selection: ModelSelection }>) {
    const { launch } = props.selection;
    const machines = useMachineListForServer(launch.executionTarget.serverId);
    const display = resolveExecutableModelParticipantDisplay(launch, machines ?? []);
    const machine = machines?.find(entry => entry.id === launch.executionTarget.machineId);
    const folder = launch.directory.kind === 'path'
        ? formatPathRelativeToHome(launch.directory.path, machine?.metadata?.homeDir) : null;
    const permission = launch.permissionMode && isPermissionMode(launch.permissionMode) && display.agentId
        ? getPermissionModeLabelForAgentType(display.agentId, launch.permissionMode) : null;
    return <Text testID="second-opinion.selected-model" style={styles.recipeText} numberOfLines={2}>
        {[display.modelLabel, display.machineLabel].filter(Boolean).join(' · ')}
        {folder ? <Text style={styles.recipeText}>{' · '}<Text style={styles.recipePath}>{folder}</Text></Text> : null}
        {permission ? ` · ${permission}` : null}
    </Text>;
}

const styles = StyleSheet.create((theme) => ({
    root: { gap: theme.space.s12 },
    markSlot: { width: ICON_SIZE.md, height: ICON_SIZE.md },
    groupRow: {
        flexDirection: 'row',
        // The label carries its group spacing above it; the hint or role link sits on its baseline.
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: theme.space.s8,
        paddingRight: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
    },
    // Headings, the question and the row marks share the form's one edge, so menu rows and their
    // group labels hang their own inset into the gutter and a chosen row's tint reaches past it.
    hang: { marginHorizontal: -HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx },
    groupNote: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, flexShrink: 1 },
    recipeText: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    recipePath: { ...Typography.mono(), color: theme.colors.text.secondary },
}));
