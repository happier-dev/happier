import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import type { WorkflowBlockKind, WorkflowLeafBlockSeed } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowStarterExampleSelection } from '@happier-dev/protocol/workflows/builtins/examples';
import { WorkflowExamplesPopover } from '../library/WorkflowExamplesPopover';

import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { resolvePluginContributedActionIconName } from '@/components/plugins/actions/pluginContributedActionPresentation';
import type { SelectionListOption, SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

import { useWorkflowActionCatalog } from '@/components/workflows/presentation/useWorkflowActionCatalog';
import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import {
    listBuiltinWorkflowReferenceOptions,
    useWorkflowReferenceLibrary,
    type WorkflowReferenceOption,
} from '@/components/workflows/presentation/workflowReferenceOptions';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';
import { WorkflowBuiltinMark } from '@/components/workflows/presentation/WorkflowBuiltinMark';
import { workflowEditorStyles } from './workflowEditorStyles';

/** What the Add menu asks its list to insert: a structure or Agent step by kind, or a step-kind seed. */
export type WorkflowAddBlockRequest =
    | Readonly<{ kind: WorkflowBlockKind }>
    | WorkflowLeafBlockSeed;

/**
 * One contextual Add control per block-list scope (04 §4.3, 07 S9): the step
 * kinds first — Agent step, Run a workflow ›, Action ›, Wait for you — then
 * structure — Side by side, Repeat, If. Run a workflow and Action push a
 * searchable step in the same canonical SelectionList popover.
 */
export function WorkflowAddBlockMenu(props: Readonly<{
    onAdd: (request: WorkflowAddBlockRequest) => void;
    onUseExample?: (example: WorkflowStarterExampleSelection) => void;
    /** Names the scope the new block joins, for the accessible label. */
    scopeLabel: string;
    composerScope?: AuthoringComposerScope;
    /** This workflow's own reference, offered dimmed with its reason (it cannot run itself). */
    currentWorkflowRef?: string | null;
    /**
     * `row`: the end-of-list "+ Add". `inserter`: the gap between two blocks —
     * a hairline with a centred (+), revealed on hover or keyboard focus, and
     * shown on touch while a block in this list is selected (`revealed`). Both
     * open the same menu at the exact insertion position the caller binds.
     */
    variant?: 'row' | 'inserter';
    revealed?: boolean;
    /** `row` only: the host's own bar holds Add (a phone), so this row offers only Start from an example. */
    examplesOnly?: boolean;
    /**
     * `verb`: what a one-step sentence does (D10 "Automate this…"): Run a command, Send a message to a session,
     * Start a session, then Another step › with every workflow step Action. The host replaces its one step.
     */
    purpose?: 'add' | 'verb';
    /** A host that draws its own Add (the Sentence view's "Add another step" chip); the menu stays this one. */
    renderTrigger?: (trigger: Readonly<{ open: boolean; toggle: () => void; anchorRef: React.RefObject<View | null> }>) => React.ReactNode;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const touchPrimaryPointer = useHappierTouchPrimaryPointer(Platform.OS);
    const anchorRef = React.useRef<View>(null);
    const examplesAnchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [examplesOpen, setExamplesOpen] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []);

    if (props.renderTrigger !== undefined) {
        return (
            <>
                {props.renderTrigger({ open, toggle: () => setOpen((value) => !value), anchorRef })}
                {open ? (
                    <WorkflowAddBlockMenuPopover
                        composerScope={props.composerScope}
                        anchorRef={anchorRef}
                        onAdd={props.onAdd}
                        onClose={close}
                        {...(props.purpose === undefined ? {} : { purpose: props.purpose })}
                        {...(props.currentWorkflowRef === undefined ? {} : { currentWorkflowRef: props.currentWorkflowRef })}
                        {...(props.testID === undefined ? {} : { testID: props.testID })}
                    />
                ) : null}
            </>
        );
    }

    if (props.variant === 'inserter') {
        // Under a finger a hidden inserter is inert: its target overlaps its neighbours' edges so the
        // gap stays the document's rhythm (lab P1), and it must never take a tap meant for them.
        const inert = touchPrimaryPointer && !open && props.revealed !== true;
        return (
            <View ref={anchorRef} collapsable={false} style={workflowEditorStyles.inserterSlot}
                pointerEvents={inert ? 'none' : 'auto'}
                {...(inert ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const } : {})}>
                <HappierPressable
                    testID={props.testID}
                    accessibilityRole="button"
                    accessibilityLabel={t('workflows.editor.addAccessibility')}
                    accessibilityHint={props.scopeLabel}
                    onPress={() => setOpen((value) => !value)}
                    expanded={open}
                    hasPopup="menu"
                    style={(state) => [
                        workflowEditorStyles.inserter,
                        open || props.revealed === true || state.hovered || state.focused
                            ? null
                            : workflowEditorStyles.inserterHidden,
                        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                    ]}
                >
                    <View style={workflowEditorStyles.inserterLine} />
                    <Icon name="plus" size={14} color={theme.colors.text.secondary} />
                    <View style={workflowEditorStyles.inserterLine} />
                </HappierPressable>
                {open ? (
                    <WorkflowAddBlockMenuPopover
                        composerScope={props.composerScope}
                        anchorRef={anchorRef}
                        onAdd={props.onAdd}
                        onClose={close}
                        {...(props.currentWorkflowRef === undefined ? {} : { currentWorkflowRef: props.currentWorkflowRef })}
                        {...(props.testID === undefined ? {} : { testID: props.testID })}
                    />
                ) : null}
            </View>
        );
    }

    return (
        <View style={workflowEditorStyles.addRow}>
            {props.examplesOnly === true ? null : <View ref={anchorRef} collapsable={false}>
                <HappierPressable
                    testID={props.testID}
                    accessibilityRole="button"
                    accessibilityLabel={t('workflows.editor.addAccessibility')}
                    accessibilityHint={props.scopeLabel}
                    onPress={() => setOpen((value) => !value)}
                    expanded={open}
                    hasPopup="menu"
                    style={(state) => [
                        workflowEditorStyles.actionTarget,
                        workflowEditorStyles.addTrigger,
                        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                    ]}
                >
                    <Icon name="plus" size={16} color={theme.colors.text.primary} />
                    <Text style={workflowEditorStyles.addLabel}>{t('workflows.editor.add')}</Text>
                </HappierPressable>
            </View>}
            {props.onUseExample === undefined ? null : <View ref={examplesAnchorRef} collapsable={false}>
                <RoundButton testID={`${props.testID}-examples`} size="small" display="inverted"
                    title={t('workflows.examples.title')} onPress={() => setExamplesOpen(true)} />
            </View>}
            {open ? (
                <WorkflowAddBlockMenuPopover
                    composerScope={props.composerScope}
                    anchorRef={anchorRef}
                    onAdd={props.onAdd}
                    onClose={close}
                    {...(props.currentWorkflowRef === undefined ? {} : { currentWorkflowRef: props.currentWorkflowRef })}
                    {...(props.testID === undefined ? {} : { testID: props.testID })}
                />
            ) : null}
            {examplesOpen ? <WorkflowExamplesPopover anchorRef={examplesAnchorRef} onRequestClose={() => setExamplesOpen(false)} onUse={props.onUseExample} /> : null}
        </View>
    );
}

/** The open menu: mounted only while open, so its catalog and library reads happen on demand. */
function WorkflowAddBlockMenuPopover(props: Readonly<{
    composerScope?: AuthoringComposerScope;
    anchorRef: React.RefObject<View | null>;
    onAdd: (request: WorkflowAddBlockRequest) => void;
    onClose: () => void;
    purpose?: 'add' | 'verb';
    currentWorkflowRef?: string | null;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const library = useWorkflowReferenceLibrary();
    const libraryOptions = library.options;
    const catalog = useWorkflowActionCatalog(props.composerScope);
    const { onAdd, onClose } = props;
    const rootStep = React.useMemo((): SelectionListStep => {
        const add = (request: WorkflowAddBlockRequest) => () => {
            onClose();
            onAdd(request);
        };
        const optionId = (suffix: string) => (props.testID === undefined ? suffix : `${props.testID}-${suffix}`);
        const workflowOption = (option: WorkflowReferenceOption): SelectionListOption => {
            const self = props.currentWorkflowRef !== undefined && props.currentWorkflowRef === option.ref;
            return {
                id: optionId(`workflow:${option.ref}`),
                label: option.title,
                icon: () => option.icon === undefined
                    ? <Icon name={WORKFLOW_BLOCK_KIND_GLYPH.workflow} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                    : <WorkflowBuiltinMark icon={option.icon} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
                ...(option.unavailableReason !== undefined ? { subtitle: option.unavailableReason, disabled: true } : self
                    ? { subtitle: t('workflows.page.blocks.selfRef', { workflow: option.title }), disabled: true }
                    : {}),
                onSelect: () => {
                    if (self || option.unavailableReason !== undefined) return;
                    add({ kind: 'workflow', workflowRef: option.ref })();
                },
            };
        };
        const workflowsStep: SelectionListStep = {
            id: 'add-workflow',
            title: t('workflows.page.blocks.menuRun'),
            inputPlaceholder: t('workflows.page.blocks.workflowSearch'),
            sections: [
                {
                    kind: 'static',
                    id: 'builtin',
                    title: t('workflows.page.blocks.builtin'),
                    options: listBuiltinWorkflowReferenceOptions().map(workflowOption),
                },
                ...(libraryOptions.length === 0 ? [] : [{
                    kind: 'static' as const,
                    id: 'library',
                    title: t('workflows.page.blocks.libraryGroup'),
                    options: libraryOptions.map(workflowOption),
                }]),
                ...(library.hasMore ? [{ kind: 'static' as const, id: 'more-workflows', options: [{
                    id: optionId('workflow-more'), label: t(library.loadingMore ? 'common.loading' : 'common.more'),
                    disabled: library.loadingMore, onSelect: library.loadMore,
                }] }] : []),
                ...(library.status === 'failed' ? [{ kind: 'static' as const, id: 'retry-workflows', options: [{
                    id: optionId('workflow-retry'), label: t('common.retry'), onSelect: library.retry,
                }] }] : []),
            ],
        };
        const actionOption = (spec: (typeof catalog.specs)[number]): SelectionListOption => ({
            id: optionId(`action:${spec.id}`),
            label: spec.title,
            searchText: spec.id,
            subtitle: spec.projectionError ? t('workflows.page.blocks.actionUnavailable', { action: spec.title }) : spec.description?.trim() || spec.plugin?.title,
            // A picker row says what the Action does in a glance; its whole description is on the step it adds.
            subtitleLines: 2,
            disabled: spec.projectionError !== undefined,
            icon: () => <Icon name={spec.plugin ? resolvePluginContributedActionIconName(spec.plugin.icon) : spec.icon ?? 'lightning'}
                size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
            // Host Actions sit under the host's own section title, so a row names its source only when it adds
            // something (a plugin, or where a host Action reaches: "Phone").
            ...(spec.plugin || spec.sourceLabel ? { rightAccessory: <Text numberOfLines={1} style={{ ...Typography.variant('meta'), color: theme.colors.text.tertiary }}>
                {spec.plugin?.title ?? spec.sourceLabel}
            </Text> } : {}),
            onSelect: spec.projectionError ? undefined : add({ kind: 'action', actionId: spec.id }),
        });
        const actionsStep: SelectionListStep = {
            id: 'add-action',
            title: t('workflows.page.blocks.menuAction'),
            inputPlaceholder: t('workflows.page.blocks.actionSearch'),
            sections: [
                { kind: 'static', id: 'host-actions', title: t('workflows.actionTitles.host'),
                    options: catalog.specs.filter((spec) => !spec.plugin).map(actionOption) },
                ...(catalog.specs.some((spec) => spec.plugin) ? [{
                    kind: 'static' as const, id: 'plugin-actions', title: t('workflows.plugins.fromPlugins'),
                    options: catalog.specs.filter((spec) => spec.plugin).map(actionOption),
                }] : []),
            ],
        };
        const effectPresets = [
            { actionId: 'webhooks.call', suffix: 'webhook' },
            { actionId: 'machines.command.run', suffix: 'command' },
        ].flatMap(({ actionId, suffix }) => {
            const spec = catalog.specs.find((candidate) => candidate.id === actionId);
            return spec === undefined ? [] : [{ ...actionOption(spec), id: optionId(suffix) }];
        });
        const actionSearch = {
            kind: 'dynamic' as const, id: 'action-search', title: t('workflows.page.blocks.menuAction'),
            resolverKey: JSON.stringify(catalog.specs),
            visibleWhen: (input: string) => input.trim().length > 0,
            debounceMs: 0, loadingSkeletonRows: 0,
            resolve: async () => ({ options: catalog.specs.map(actionOption) }),
        };
        if (props.purpose === 'verb') {
            const verbIcon = (name: React.ComponentProps<typeof Icon>['name']) => () => <Icon name={name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
            // A verb is the Action's own preset, offered only while the catalog lists that Action here.
            const verbPreset = (actionId: string, verb: 'command' | 'message', icon: React.ComponentProps<typeof Icon>['name']) => {
                const spec = catalog.specs.find((candidate) => candidate.id === actionId);
                if (spec === undefined || spec.projectionError !== undefined) return [];
                const { rightAccessory: _source, ...option } = actionOption(spec);
                return [{ ...option, id: optionId(`verb-${verb}`), label: t(`workflows.sentence.verbs.${verb}Menu`),
                    subtitle: t(`workflows.sentence.verbs.${verb}Sub`), icon: verbIcon(icon) }];
            };
            return {
                id: 'verb-root',
                title: t('workflows.sentence.verbs.title'),
                inputPlaceholder: t('common.search'),
                searchAcrossSections: true,
                sections: [
                    { kind: 'static', id: 'verbs', options: [
                        ...verbPreset('machines.command.run', 'command', 'terminal'),
                        ...verbPreset('session.message.send', 'message', 'chat-circle'),
                        { id: optionId('verb-session'), label: t('workflows.sentence.verbs.sessionMenu'), subtitle: t('workflows.sentence.verbs.sessionSub'),
                            icon: verbIcon('sparkle'), onSelect: add({ kind: 'step' }) },
                    ] },
                    { kind: 'static', id: 'another', options: [
                        { id: optionId('verb-another'), label: t('workflows.sentence.verbs.anotherMenu'), subtitle: t('workflows.sentence.verbs.anotherSub'),
                            subtitleLines: 2, icon: verbIcon(WORKFLOW_BLOCK_KIND_GLYPH.action), openStep: actionsStep },
                    ] },
                    actionSearch,
                ],
            };
        }
        return {
            id: 'add-root',
            title: t('workflows.editor.add'),
            inputPlaceholder: t('common.search'),
            searchAcrossSections: true,
            sections: [
                {
                    kind: 'static',
                    id: 'kinds',
                    title: t('workflows.tabs.steps'),
                    options: [
                        { id: optionId('step'), label: t('workflows.editor.addStep'), subtitle: t('workflows.page.blocks.agentSub'), icon: () => <Icon name={WORKFLOW_BLOCK_KIND_GLYPH.step} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />, onSelect: add({ kind: 'step' }) },
                        { id: optionId('workflow'), label: t('workflows.page.blocks.menuRun'), subtitle: t('workflows.page.blocks.workflowSub'), icon: () => <Icon name={WORKFLOW_BLOCK_KIND_GLYPH.workflow} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />, openStep: workflowsStep },
                        { id: optionId('action'), label: t('workflows.page.blocks.menuAction'), subtitle: t('workflows.page.blocks.noAgentTurn'), icon: () => <Icon name={WORKFLOW_BLOCK_KIND_GLYPH.action} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />, openStep: actionsStep },
                        ...effectPresets,
                        { id: optionId('wait'), label: t('workflows.page.blocks.menuWait'), subtitle: t('workflows.page.blocks.waitSub'), icon: () => <Icon name={WORKFLOW_BLOCK_KIND_GLYPH.wait} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />, onSelect: add({ kind: 'wait' }) },
                    ],
                },
                {
                    kind: 'static',
                    id: 'structure',
                    title: t('workflows.actionTitles.structure'),
                    options: [
                        { id: optionId('parallel'), label: t('workflows.editor.addParallel'), subtitle: t('workflows.page.blocks.parallelSub'), icon: () => <Icon name={WORKFLOW_BLOCK_KIND_GLYPH.parallel} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />, onSelect: add({ kind: 'parallel' }) },
                        { id: optionId('loop'), label: t('workflows.editor.addLoop'), subtitle: t('workflows.page.blocks.loopSub'), icon: () => <Icon name={WORKFLOW_BLOCK_KIND_GLYPH.loop} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />, onSelect: add({ kind: 'loop' }) },
                        { id: optionId('if'), label: t('workflows.editor.addIf'), subtitle: t('workflows.page.blocks.ifSub'), icon: () => <Icon name={WORKFLOW_BLOCK_KIND_GLYPH.if} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />, onSelect: add({ kind: 'if' }) },
                    ],
                },
                {
                    // Typing a workflow's name finds it here too, not only behind "Run a workflow ›" (DESIGN-9 N45).
                    kind: 'dynamic', id: 'workflow-search', title: t('workflows.page.blocks.menuRun'),
                    resolverKey: JSON.stringify(libraryOptions),
                    visibleWhen: (input) => input.trim().length > 0,
                    debounceMs: 0, loadingSkeletonRows: 0,
                    resolve: async () => ({ options: [...listBuiltinWorkflowReferenceOptions(), ...libraryOptions].map(workflowOption) }),
                },
                actionSearch,
            ],
        };
    }, [libraryOptions, library.hasMore, library.loadingMore, library.loadMore, library.retry, library.status,
        catalog.specs, onAdd, onClose, props.currentWorkflowRef, props.purpose, props.testID, theme.colors.text.secondary, theme.colors.text.tertiary]);

    return (
        <AgentInputSelectionListPopover
            open
            anchorRef={props.anchorRef}
            rootStep={rootStep}
            optionPresentation="menu"
            heightBehavior="fixedToMaxHeight"
            onSelect={() => {
                // Each option's own `onSelect` is the action source and closes the menu.
            }}
            onRequestClose={onClose}
            maxHeightCap={480}
            {...(props.testID === undefined ? {} : { testID: `${props.testID}-menu` })}
        />
    );
}
