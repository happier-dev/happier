import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
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
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { getPermissionModeLabelForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { StatusPill } from '@/components/ui/status/StatusPill';
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

/** The model row a chosen recipe came from: its Agent on its Machine, else the Machine's own row. */
function modelRowIds(selection: ModelSelection): readonly string[] {
    const machineId = selection.launch.executionTarget.machineId;
    const agentId = resolveBundledAgentIdFromContributionIdentity(selection.launch.agentTarget.identity);
    return agentId ? [`model:${machineId}:${agentId}`, `model:${machineId}`] : [`model:${machineId}`];
}

/**
 * Shared fields only; the host retains its existing admission controller and typed result adapter.
 * Lab flows `flOpinion`: one Who list (models, then Sessions and Bots, each naming its type). A chosen
 * model reads its recipe as its row's line with Change beside the check; Change opens the recipe right
 * under the list and sets the question aside until it closes. People follow as their own calm section.
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
    const { source, where } = model;
    const { participants } = source;
    const busy = !source.enabled || source.busy === true;
    const [detailId, setDetailId] = React.useState<string | null>(null);
    const [accessoryOpen, setAccessoryOpen] = React.useState(false);
    const [expanded, setExpanded] = React.useState(false);
    // Which row's recipe is settling (one-tap default) or open (Change). Presentation only: the recipe
    // and its value stay with the participant owner.
    const [recipe, setRecipe] = React.useState<Readonly<{ rowId: string; mode: 'default' | 'change' }> | null>(null);
    const editor = participants?.who.recipeEditor ?? null;
    const openRecipe = editor ? recipe : null;
    const onChoose = participants?.input.onChoose;
    const onReplace = participants?.input.onReplace;
    const editModel = participants?.who.editModel;

    const display = React.useMemo(() => {
        const categoryOf = new Map(source.sections.map(entry => [entry.section.id, entry.category] as const));
        const agentSections = model.rootStep.sections.filter(section => categoryOf.get(section.id) !== 'person');
        const peopleSections = model.rootStep.sections.filter(section => categoryOf.get(section.id) === 'person');
        const rowIds = new Set(agentSections.flatMap(section => section.kind === 'static' ? section.options.map(option => option.id) : []));
        // Each chosen model claims the first row it came from; one with no row left reads beneath the list.
        const chosenByRow = new Map<string, ModelSelection>();
        const unplaced: ModelSelection[] = [];
        for (const selection of participants?.input.selected ?? []) {
            if (selection.kind !== 'model') continue;
            const rowId = modelRowIds(selection).find(id => rowIds.has(id) && !chosenByRow.has(id));
            if (rowId) chosenByRow.set(rowId, selection);
            else unplaced.push(selection);
        }
        const decorate = (option: SelectionListOption): SelectionListOption => {
            const detail = details?.get(option.id);
            if (detail) return { ...option, rightAccessoryOutsidePressable: true,
                rightAccessory: <TextLinkButton testID={`contextual-start-change:${option.id}`} tone="strong" size="meta"
                    label={t('common.change')} disabled={busy || option.disabled}
                    onPress={() => setDetailId(current => current === option.id ? null : option.id)} /> };
            if (option.openStep || !option.id.startsWith('model:')) return option;
            const chosen = chosenByRow.get(option.id);
            const settling = openRecipe?.mode === 'default' && openRecipe.rowId === option.id;
            return {
                ...option,
                // A chosen recipe unchooses on its row; a new one settles its defaults right here.
                onSelect: chosen ? () => onChoose?.(chosen) : () => { setRecipe({ rowId: option.id, mode: 'default' }); option.onSelect?.(); },
                ...(settling ? { subtitleContent: <Text style={styles.recipeText}>{t('common.loading')}</Text> } : {}),
                ...(chosen ? {
                    subtitleContent: <RecipeSummary selection={chosen} />,
                    subtitleLines: 2,
                    rightAccessoryOutsidePressable: true,
                    rightAccessory: <TextLinkButton testID="second-opinion.change-model" tone="strong" size="meta"
                        label={t('common.change')} disabled={busy}
                        onPress={() => {
                            setRecipe({ rowId: option.id, mode: 'change' });
                            editModel?.(chosen, next => onReplace?.(chosen, next));
                        }} />,
                } : {}),
            };
        };
        const selectedIds = new Set(model.selectedIds);
        for (const rowId of chosenByRow.keys()) selectedIds.add(rowId);
        if (openRecipe?.mode === 'default') selectedIds.add(openRecipe.rowId);
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
            return { step: { ...model.rootStep, sections: [...sections, ...peopleSections] }, selectedIds, unplaced };
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
        const topSection: SelectionListSectionDescriptor = { kind: 'static', id: 'who:top', options: [...top.map(decorate), ...stateRows, showAll] };
        // People live inside Show all; ones already chosen stay in sight.
        return { step: { ...model.rootStep, inputPlaceholder: peopleChosen ? model.rootStep.inputPlaceholder : undefined,
            sections: [topSection, ...(peopleChosen ? peopleSections : [])] }, selectedIds, unplaced };
    }, [busy, details, detailId, editModel, expanded, participants?.input.selected, participants?.input.people?.chosen, model.rootStep, model.selectedIds, onChoose, onReplace, openRecipe, source.sections]);
    const changing = editor !== null && openRecipe?.mode === 'change';

    return <View testID="contextual-start-composer" style={styles.root}>
        <View>
            <View style={[styles.groupRow, styles.hang]}>
                <CollectionListGroupLabel title={t('agentStart.chips.engineTitle')} presentation="menu" />
                {whoHint ? <Text style={styles.groupNote} numberOfLines={1}>{whoHint}</Text> : null}
                {/* The link holds its own start alignment; its wrapper joins the label's baseline. */}
                {whoAccessory ? <View><TextLinkButton testID="contextual-start-who-accessory" tone="strong" size="meta"
                    label={whoAccessory.label} disabled={busy} onPress={() => setAccessoryOpen(value => !value)} /></View> : null}
            </View>
            <View style={styles.hang}>
                <SelectionList testID="contextual-start-who" rootStep={display.step}
                    inputValue={source.search?.value} onChangeInputValue={source.search?.onChange}
                    selection={{ kind: 'multiple', selectedIds: display.selectedIds }}
                    onSelect={() => undefined} onRequestClose={() => undefined}
                    listAccessibilityLabel={t('agentStart.chips.engineTitle')}
                    optionsHostInlineControls selectionMark="check" surface="none" disableTransitions
                />
            </View>
            {display.unplaced.map((selection, index) => <View key={index} style={styles.hang}>
                <Item testID="second-opinion.selected-model-row" density="compact" showChevron={false} showDivider={false}
                    selected disabled={busy} title={<UnplacedRecipeTitle selection={selection} />}
                    subtitle={<RecipeSummary selection={selection} />} onPress={() => onChoose?.(selection)}
                    rightElement={<TextLinkButton testID="second-opinion.change-model" tone="strong" size="meta"
                        label={t('common.change')} disabled={busy}
                        onPress={() => { setRecipe({ rowId: `unplaced:${index}`, mode: 'change' }); editModel?.(selection, next => onReplace?.(selection, next)); }} />} />
            </View>)}
            {/* The recipe settles here (one tap) or opens here (Change); it never covers the form. */}
            {editor}
            {detailId ? details?.get(detailId)?.() : null}
            {accessoryOpen ? whoAccessory?.render(() => setAccessoryOpen(false)) : null}
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

function UnplacedRecipeTitle(props: Readonly<{ selection: ModelSelection }>) {
    const label = useExecutableParticipantLabel(props.selection, props.selection.launch.executionTarget.serverId);
    return <>{label ?? t('session.collaboration.discussion.heldParticipant')}</>;
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
