import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { workflowStarterRequiresSession, type WorkflowStarterExampleSelection, type WorkflowStarterSessionTarget, type WorkflowStarterExampleKeyV1, type WorkflowStarterExampleV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { Modal } from '@/modal';
import { getPreferredLanguage, t, tLoose } from '@/text';
import { en } from '@/text/translations/en';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { storeWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { listWorkflowStarters, resolveWorkflowStarter } from '@/sync/domains/workflows/resolveWorkflowStarter';
import { formatWorkflowProblemMessage } from '../presentation/workflowProblemPresentation';
import { useWorkflowExistingSessionOptions } from '../screens/useWorkflowExistingSessionOptions';
import { resolveWorkflowSessionChoice, WORKFLOW_SESSION_RETRY_ITEM_ID, workflowSessionMenuState } from '../presentation/workflowSessionChoice';
import { workflowSessionOptionRow } from '../presentation/workflowSessionOptionRow';
import { readDeviceTimeZone } from '../triggers/sessionTriggerForm';
import { WorkflowFlowView } from '../flow/WorkflowFlowView';
import { projectWorkflowFlow } from '../flow/workflowFlowProjection';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
import { WorkflowExamplesPopover } from './WorkflowExamplesPopover';

/**
 * Inside a Session the example is already bound to it, so a description that begins "Choose a session…"
 * would ask for a choice that is not there. These say what the example does *here*; the others read the
 * same in both places.
 */
const SESSION_DESCRIPTION_KEYS: Partial<Record<WorkflowStarterExampleKeyV1, 'workflows.examples.sessionNotifyDescription'
    | 'workflows.examples.sessionDailySummaryDescription' | 'workflows.examples.sessionTestDescription'>> = {
    'notify-when-agent-waits': 'workflows.examples.sessionNotifyDescription',
    'daily-summary-in-session': 'workflows.examples.sessionDailySummaryDescription',
    'test-after-every-turn': 'workflows.examples.sessionTestDescription',
};

/** Examples the catalog added recently carry a quiet "New" mark wherever they are offered (lab `b-habit T`). */
const NEW_EXAMPLE_KEYS: ReadonlySet<WorkflowStarterExampleKeyV1> = new Set(['memory-upkeep-in-session']);

function ExampleNewTag(props: Readonly<{ example: WorkflowStarterExampleV1 }>) {
    if (!NEW_EXAMPLE_KEYS.has(props.example.key)) return null;
    return <StatusPill testID={`workflow-examples:${props.example.key}:new`} variant="info" hideDot
        label={t('workflows.examples.newTag')} />;
}

/** The same read-only examples everywhere. Selection itself never writes or starts a Run. */
export function WorkflowExamplesSection(props: Readonly<{
    onUse?: (example: WorkflowStarterExampleSelection) => void;
    onDidUse?: () => void;
    /** Inline trigger selection is not a new editor draft. */
    opensDraft?: boolean;
    /**
     * Opened from a Session's Triggers "+" (lab `b-habit T`, 65s5): offer the full starter catalog
     * and supply the current Session to the existing materializer, with no chooser.
     */
    session?: WorkflowStarterSessionTarget;
    /**
     * `list`: a Session's compact one-line-per-example picker (with `session`); `cards` draws each with its map;
     * `strip`: the returning library's secondary row (lab `nav-N1`), two compact cards and the rest one press away;
     * `featured`: the first visit (lab `nav-N3`), the first few drawn as maps and the rest one press away.
     */
    presentation?: 'cards' | 'list' | 'strip' | 'featured';
    /** A phone sheet already names the picker in its header. */
    hideTitle?: boolean;
}>): React.ReactElement {
    const router = useRouter();
    const mounted = useMountedRef();
    const routeLifetime = useWorkflowAccountLifetime();
    const homeLifetime = useActiveServerAccountScopeLifetime();
    const accountLifetime = routeLifetime === undefined ? homeLifetime ?? undefined : routeLifetime;
    const [choice, setChoice] = React.useState<Readonly<{ key: string; lifetime: ActiveServerAccountScopeLifetime | null }> | null>(null);
    const [attempt, retry] = React.useReducer(current => current + 1, 0);
    const [catalog, setCatalog] = React.useState<Readonly<{
        accountLifetime: typeof accountLifetime;
        attempt: number;
        outcome: { examples: readonly WorkflowStarterExampleV1[] } | { error: unknown };
    }> | null>(null);
    React.useEffect(() => {
        const controller = new AbortController();
        void listWorkflowStarters(accountLifetime, controller.signal).then(outcome => {
            if (!controller.signal.aborted) setCatalog({ accountLifetime, attempt, outcome });
        }, error => {
            if (!controller.signal.aborted) setCatalog({ accountLifetime, attempt, outcome: { error } });
        });
        return () => controller.abort();
    }, [accountLifetime, attempt]);
    const outcome = catalog?.accountLifetime === accountLifetime && catalog?.attempt === attempt
        && accountLifetime?.isCurrent() !== false ? catalog.outcome : null;
    if (outcome === null) {
        return <EmptyState layout="line" title={t('common.loading')} loading />;
    }
    if ('error' in outcome) {
        return <EmptyState testID="workflow-examples-load-failed" layout="line" iconName="warning"
            title={formatWorkflowProblemMessage(outcome.error)}
            primaryAction={{ label: t('common.retry'), onPress: retry }} />;
    }
    const useExample = (example: WorkflowStarterExampleSelection) => {
        if (props.onUse) props.onUse(example);
        else {
            const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed({ name: tLoose(example.titleKey),
                description: tLoose(example.descriptionKey), definition: example.definition,
                trigger: example.trigger, eventSeed: example.eventSeed, sessionTarget: example.sessionTarget });
            const keepNameFocus = example.trigger === undefined && example.sessionTarget === undefined;
            router.push({ pathname: '/workflows/new', params: { definitionDraftSeedId,
                ...(keepNameFocus ? { example: example.key } : {}) } } as never);
        }
        props.onDidUse?.();
    };
    const session = props.session;
    // Event recipes need their own When setup. The block-only and inline pickers leave the receiving triggers alone.
    const opensEventDraft = props.opensDraft !== false && (props.onUse === undefined || session !== undefined);
    const examples = opensEventDraft ? outcome.examples
        : outcome.examples.filter(example => example.eventSeed === undefined
            && (props.opensDraft !== false || !workflowStarterRequiresSession(example)));
    const choose = (example: WorkflowStarterExampleV1) => {
        const lifetime = accountLifetime;
        void resolveWorkflowStarter({ key: example.key, session, timezone: readDeviceTimeZone(), accountLifetime: lifetime }).then(selection => {
            if (!mounted.current || lifetime?.isCurrent() === false) return;
            // Added into a draft, a template brings its steps and leaves that draft's triggers alone.
            if (selection.status === 'ready') useExample(props.opensDraft === false ? withoutTrigger(selection.example) : selection.example);
            else if (session === undefined) setChoice({ key: example.key, lifetime: lifetime ?? null });
        }, error => {
            if (mounted.current && lifetime?.isCurrent() !== false) void Modal.alert(t('common.error'), formatWorkflowProblemMessage(error));
        });
    };
    if (session !== undefined && props.presentation === 'list') {
        // A Session's own picker (lab `b-habit T`): the full catalog, one line each, and never a Session chooser.
        // Read as a small configuration page, like the trigger popover beside it: what the picker does sits under
        // its title at the top, and the rows lie on the picker itself. The examples made for a Session (the
        // ones that follow or run in one) lead; the general templates follow in the catalog's own order.
        const forSession = [...examples.filter(workflowStarterRequiresSession),
            ...examples.filter((example) => !workflowStarterRequiresSession(example))];
        return <ListPresentationProvider value="page"><ItemGroup surface="none"
            title={props.hideTitle ? undefined : t('workflows.examples.title')} description={t('workflows.examples.sessionDescription')}
            // A sheet that already names the picker in its own header has the description follow it directly.
            headerStyle={props.hideTitle ? styles.listHeaderUntitled : undefined}>
            {forSession.map((example) => {
                const sessionDescriptionKey = SESSION_DESCRIPTION_KEYS[example.key];
                return <Item key={example.key} testID={`workflow-examples:${example.key}`}
                    title={tLoose(example.titleKey)} titleAccessory={<ExampleNewTag example={example} />}
                    subtitle={sessionDescriptionKey ? t(sessionDescriptionKey) : tLoose(example.descriptionKey)} subtitleLines={0}
                    showChevron={false} mode="info"
                    rightElement={<RoundButton testID={`workflow-examples:${example.key}:use`} size="small" display="secondary"
                        title={t('workflows.examples.use')} accessibilityLabel={`${t('workflows.examples.use')}: ${tLoose(example.titleKey)}`}
                        onPress={() => choose(example)} />} />;
            })}
        </ItemGroup></ListPresentationProvider>;
    }
    if (props.presentation === 'strip' || props.presentation === 'featured') return <ExamplesStrip examples={examples}
        featured={props.presentation === 'featured'} choose={choose} choice={choice}
        onCloseChoice={() => setChoice(null)} onUse={useExample} />;
    return <ItemGroup title={props.hideTitle ? undefined : t('workflows.examples.title')} surface="none"
        {...(props.opensDraft === false ? {} : { description: t('workflows.examples.description') })}>
        <ExamplesPicker examples={examples} choose={choose} choice={choice} onCloseChoice={() => setChoice(null)} onUse={useExample} />
    </ItemGroup>;
}

type ExampleStart = 'runNow' | 'schedule' | 'event';
/** How an example starts: the one fact the whole catalog divides by (#184 F2: an event starter was last of 28). */
function readExampleStart(example: WorkflowStarterExampleV1): ExampleStart {
    if (example.eventSeed !== undefined || example.triggerSeed?.kind === 'sessionLifecycle') return 'event';
    return example.triggerSeed?.kind === 'schedule' ? 'schedule' : 'runNow';
}
const EXAMPLE_START_GROUPS = {
    get axis() {
        return [
            { key: 'runNow', title: t('workflows.triggers.card.manualSentence') },
            { key: 'schedule', title: t('workflows.triggers.guided.whenSchedule') },
            { key: 'event', title: t('workflows.triggers.guided.whenEvent') },
        ];
    },
    groupOf: readExampleStart,
};

/**
 * The full catalog (the library's "More", the editor and a trigger's examples): a search over names and what each
 * does, then the examples grouped by how they start (#184 F2: an event starter was the last of 28, with no search),
 * as compact cards. Maps stay on the first visit's featured cards: in the picker a deep example's map stretched its
 * row into tall blank paper (#184 F5, UI refinements 23:55Z).
 */
function ExamplesPicker(props: Readonly<{
    examples: readonly WorkflowStarterExampleV1[];
    choose: (example: WorkflowStarterExampleV1) => void;
    choice: Readonly<{ key: string; lifetime: ActiveServerAccountScopeLifetime | null }> | null;
    onCloseChoice: () => void;
    onUse: (example: WorkflowStarterExampleSelection) => void;
}>) {
    const [query, setQuery] = React.useState('');
    const needle = query.trim().toLocaleLowerCase();
    const filter = React.useMemo(() => needle.length === 0 ? undefined : (example: WorkflowStarterExampleV1) =>
        `${tLoose(example.titleKey)}\n${tLoose(example.descriptionKey)}`.toLocaleLowerCase().includes(needle), [needle]);
    return <View style={styles.picker}>
        {/* Free content in the section: the field stands on the section's text edge, with the cards and labels below. */}
        <BareSectionContent><CompactSearchField testID="workflow-examples:search" value={query} onChangeText={setQuery}
            placeholder={t('workflows.examples.searchPlaceholder')} accessibilityLabel={t('workflows.examples.searchPlaceholder')} /></BareSectionContent>
        <ExampleCards examples={props.examples} compact groups={EXAMPLE_START_GROUPS} filter={filter}
            empty={<EmptyState testID="workflow-examples:noMatch" layout="inline" iconName="magnifying-glass"
                title={t('workflows.examples.noMatch', { query: query.trim() })} />}
            choose={props.choose} choice={props.choice} onCloseChoice={props.onCloseChoice} onUse={props.onUse} />
    </View>;
}

/** How many examples the returning library shows before "more": one row of the two-column grid. */
const STRIP_EXAMPLE_COUNT = 2;
/** The first visit's look (lab `nav-N3` draws four): two rows of the grid, so the page leads with its invitation, not a catalog. */
const FEATURED_EXAMPLE_COUNT = 4;

/**
 * The returning library's examples (lab `nav-N1`): one row of compact cards under the section title, and the whole
 * catalog one press away in the same picker the column's "+" › From an example opens. The first visit draws its
 * few as full cards with their maps (lab `nav-N3`), with the same way to the rest.
 */
function ExamplesStrip(props: Readonly<{
    examples: readonly WorkflowStarterExampleV1[];
    featured: boolean;
    choose: (example: WorkflowStarterExampleV1) => void;
    choice: Readonly<{ key: string; lifetime: ActiveServerAccountScopeLifetime | null }> | null;
    onCloseChoice: () => void;
    onUse: (example: WorkflowStarterExampleSelection) => void;
}>) {
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);
    const count = props.featured ? FEATURED_EXAMPLE_COUNT : STRIP_EXAMPLE_COUNT;
    const rest = props.examples.length - count;
    const { examples } = props;
    const shown = React.useMemo(() => examples.slice(0, count), [examples, count]);
    return <ItemGroup title={t('workflows.examples.title')} description={t('workflows.examples.description')} surface="none"
        action={rest > 0 ? <View ref={anchorRef} collapsable={false}><SectionActionButton testID="workflow-examples:more"
            icon="tree-structure" title={t('common.more')} expanded={pickerOpen}
            onPress={() => setPickerOpen(true)} /></View> : undefined}>
        <ExampleCards examples={shown} compact={!props.featured} choose={props.choose} choice={props.choice} onCloseChoice={props.onCloseChoice} onUse={props.onUse} />
        {pickerOpen ? <WorkflowExamplesPopover anchorRef={anchorRef} onRequestClose={() => setPickerOpen(false)} /> : null}
    </ItemGroup>;
}

/** Session subscriptions live only in the open chooser, not every catalog card. */
function ExampleSessionChooser(props: Readonly<{
    example: WorkflowStarterExampleV1;
    lifetime: ActiveServerAccountScopeLifetime | null;
    onClose: () => void;
    onUse: (example: WorkflowStarterExampleSelection) => void;
}>) {
    const mounted = useMountedRef();
    const { lifetime } = props;
    const isCurrent = lifetime?.isCurrent() === true;
    const { existingSessions, sessionOptionsStatus, retrySessionOptions } = useWorkflowExistingSessionOptions({
        serverId: lifetime?.scope.serverId ?? null, machineId: null, enabled: isCurrent,
    });
    const sessions = isCurrent ? existingSessions : [];
    const choice = resolveWorkflowSessionChoice(sessionOptionsStatus, sessions.length > 0);
    const menu = workflowSessionMenuState(choice, tLoose('workflows.examples.noSessions'));
    return <View style={styles.chooser}>
        <DropdownMenu open onOpenChange={(open) => { if (!open) props.onClose(); }} search searchPlaceholder={t('sessionsList.searchSessionsPlaceholder')}
            items={[...menu.leadingItems, ...sessions.map(session => ({ id: session.sessionId, title: session.label, ...workflowSessionOptionRow(session) }))]} selectedId={null}
            {...(menu.emptyLabel === undefined ? {} : { emptyLabel: menu.emptyLabel })}
            matchTriggerWidth={false} popoverAccessibilityLabel={t('workflows.conversation.chooseExistingSession')}
            closeOnSelect={false}
            trigger={({ toggle }) => <RoundButton testID={`workflow-examples:${props.example.key}:use`} size="small" display="secondary"
                title={t('workflows.examples.chooseSession')}
                accessibilityLabel={`${t('workflows.examples.chooseSession')}: ${tLoose(props.example.titleKey)}`} onPress={toggle} />}
            onSelect={(sessionId) => {
                if (sessionId === WORKFLOW_SESSION_RETRY_ITEM_ID) { retrySessionOptions(); return; }
                if (!lifetime?.isCurrent()) return;
                const session = sessions.find(candidate => candidate.sessionId === sessionId);
                if (!session) return;
                const serverId = resolvePortableServerIdentityForRoutingId(lifetime.scope.serverId);
                void resolveWorkflowStarter({ key: props.example.key, accountLifetime: lifetime,
                    session: { ...session, ...(serverId === null ? {} : { serverId }) }, timezone: readDeviceTimeZone(),
                }).then(selection => {
                    if (!mounted.current || !lifetime.isCurrent() || selection.status !== 'ready') return;
                    props.onClose();
                    props.onUse(selection.example);
                }, error => {
                    if (mounted.current && lifetime.isCurrent()) void Modal.alert(t('common.error'), formatWorkflowProblemMessage(error));
                });
            }} />
        {/* Only a settled read without Sessions is "none"; loading and failure stay in the open chooser. */}
        {choice === 'empty' ? <Text style={styles.description}>{tLoose('workflows.examples.noSessions')}</Text> : null}
    </View>;
}

/** Two cards side by side in a library or picker column; a phone stacks them. */
const EXAMPLE_CARD_MIN_WIDTH_PX = 320;
const passThroughScroller = (children: React.ReactNode) => children;
const readExampleKey = (example: WorkflowStarterExampleV1) => example.key;

/**
 * The examples as the one Collection card (DESIGN.md → "Happier has one card"): what each does, its **Use this** in
 * the right slot, the thing itself as the small map, and the one fact that sizes it at the foot. Pressing the card
 * uses it too, since an example has no page of its own to open.
 */
function ExampleCards(props: Readonly<{
    examples: readonly WorkflowStarterExampleV1[];
    compact?: boolean;
    groups?: typeof EXAMPLE_START_GROUPS;
    filter?: (example: WorkflowStarterExampleV1) => boolean;
    empty?: React.ReactNode;
    choose: (example: WorkflowStarterExampleV1) => void;
    choice: Readonly<{ key: string; lifetime: ActiveServerAccountScopeLifetime | null }> | null;
    onCloseChoice: () => void;
    onUse: (example: WorkflowStarterExampleSelection) => void;
}>) {
    const { examples, compact, choose, choice, onCloseChoice, onUse, groups, filter } = props;
    const { theme } = useUnistyles();
    const language = getPreferredLanguage();
    const projections = React.useMemo(() => {
        const nodeLabels = Object.fromEntries(Object.keys(en.workflows.examples.nodes).map(key => [key,
            t(`workflows.examples.nodes.${key as keyof typeof en.workflows.examples.nodes}`)]));
        return new Map(examples.map(example => [example.key, projectWorkflowFlow(example.definition, {}, nodeLabels)]));
    }, [examples, language]);
    const onOpenChange = React.useCallback((key: string | null) => {
        const example = examples.find(candidate => candidate.key === key);
        if (example) choose(example);
    }, [choose, examples]);
    const model = useHappierCollection<WorkflowStarterExampleV1>({ items: examples, keyOf: readExampleKey, openKey: null, onOpenChange,
        ...(groups === undefined ? {} : { groups }), ...(filter === undefined ? {} : { filter }) });
    const glyphColor = theme.colors.text.secondary;
    const anatomy = React.useMemo((): CollectionAnatomy<WorkflowStarterExampleV1> => ({
        glyph: () => <Icon name="tree-structure" size={20} color={glyphColor} />,
        title: (example) => tLoose(example.titleKey),
        titleSuffix: (example) => (NEW_EXAMPLE_KEYS.has(example.key) ? <ExampleNewTag example={example} /> : null),
        description: (example) => tLoose(example.descriptionKey),
        accessibilityLabel: (example) => tLoose(example.titleKey),
        testID: (example) => `workflow-examples:${example.key}`,
        columnTitles: { title: t('workflows.examples.title') },
        card: {
            headerRight: (example) => (choice?.key === example.key
                ? <ExampleSessionChooser example={example} lifetime={choice.lifetime} onClose={onCloseChoice} onUse={onUse} />
                : <RoundButton testID={`workflow-examples:${example.key}:use`} size="small" display="secondary"
                    title={t('workflows.examples.use')} accessibilityLabel={`${t('workflows.examples.use')}: ${tLoose(example.titleKey)}`} onPress={() => choose(example)} />),
            facts: (example) => {
                const structure = projections.get(example.key)?.nodes.find(node => node.kind === 'parallel' || node.kind === 'loop' || node.kind === 'if');
                const shape = structure?.kind === 'parallel' ? t('workflows.editor.addParallel') : structure?.label;
                return <Text style={styles.meta}>{[t('workflows.examples.stepCount', { count: countWorkflowStepsV1(example.definition.blocks) }), shape].filter(Boolean).join(' · ')}</Text>;
            },
            ...(compact ? {} : { body: { render: (example: WorkflowStarterExampleV1) => {
                const projection = projections.get(example.key);
                return projection ? <View testID={`workflow-examples:${example.key}:preview`} style={styles.preview}>
                    {/* The one map at its small size (lab nav-N3 `uwMap(…, { sm: true })`): one-line labels on
                        the card's own paper, so a short example leaves quiet space, not an empty well (DESIGN-7 P5). */}
                    <WorkflowFlowView projection={projection} selectedNodeId={null} preview density="compact"
                        testIDPrefix={`workflow-examples:${example.key}:flow`} />
                </View> : null;
            } } }),
        },
    }), [choice, choose, compact, glyphColor, onCloseChoice, onUse, projections]);
    // The grid draws its own gutter inside the section's content: pull it back out so the cards stand on the page's edge.
    return <View style={styles.cards}>
        <CoreCollectionScope renderPageScroller={passThroughScroller}>
            <Collection<WorkflowStarterExampleV1>
                testID="workflow-examples:cards"
                model={model}
                anatomy={anatomy}
                accessibilityLabel={t('workflows.examples.title')}
                presentation="grid"
                detail="none"
                scroll="page"
                minListWidth={EXAMPLE_CARD_MIN_WIDTH_PX}
                minDetailWidth={EXAMPLE_CARD_MIN_WIDTH_PX}
                preferredListRatio={1}
                minCardWidth={EXAMPLE_CARD_MIN_WIDTH_PX}
                {...(props.empty === undefined ? {} : { empty: props.empty })}
            />
        </CoreCollectionScope>
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    listHeaderUntitled: { paddingTop: 0 },
    picker: { gap: theme.space.s12 },
    cards: { marginHorizontal: -HAPPIER_PAGE_METRICS.sheetInsetPx },
    // A short map beside a taller neighbour sits in the middle of the paper it is given, not on top of an
    // empty well (DESIGN-9 P5 "Ask once").
    preview: { flexGrow: 1, justifyContent: 'center' },
    description: { ...Typography.variant('body'), color: theme.colors.text.secondary },
    meta: { ...Typography.variant('meta'), flexShrink: 1, color: theme.colors.text.tertiary },
    chooser: { flexShrink: 1, minWidth: 0, alignItems: 'flex-end', gap: theme.space.s4 },
}));

function withoutTrigger(example: WorkflowStarterExampleSelection): WorkflowStarterExampleSelection {
    const { trigger: _trigger, triggerSeed: _seed, ...steps } = example;
    return steps;
}
