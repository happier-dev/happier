import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { WorkflowBlockKind, WorkflowLeafBlockSeed } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowStarterExampleV1 } from '@happier-dev/protocol';
import { WorkflowExamplesPopover } from '../library/WorkflowExamplesPopover';

import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import { Icon } from '@/components/ui/icons/Icon';
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
import { workflowEditorStyles, workflowPressFeedbackStyle } from './workflowEditorStyles';

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
    onUseExample?: (example: WorkflowStarterExampleV1) => void;
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
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [examplesOpen, setExamplesOpen] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []);

    if (props.variant === 'inserter') {
        return (
            <View ref={anchorRef} collapsable={false}>
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
                        workflowPressFeedbackStyle(state, theme.colors.border.focus),
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
            <View ref={anchorRef} collapsable={false}>
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
                        workflowPressFeedbackStyle(state, theme.colors.border.focus),
                    ]}
                >
                    <Icon name="plus" size={16} color={theme.colors.text.primary} />
                    <Text style={workflowEditorStyles.addLabel}>{t('workflows.editor.add')}</Text>
                </HappierPressable>
            </View>
            {props.onUseExample === undefined ? null : <RoundButton testID={`${props.testID}-examples`} size="small" display="inverted"
                title={t('workflows.examples.title')} onPress={() => setExamplesOpen(true)} />}
            {open ? (
                <WorkflowAddBlockMenuPopover
                    composerScope={props.composerScope}
                    anchorRef={anchorRef}
                    onAdd={props.onAdd}
                    {...(props.onUseExample === undefined ? {} : { onExamples: () => { setOpen(false); setExamplesOpen(true); } })}
                    onClose={close}
                    {...(props.currentWorkflowRef === undefined ? {} : { currentWorkflowRef: props.currentWorkflowRef })}
                    {...(props.testID === undefined ? {} : { testID: props.testID })}
                />
            ) : null}
            {examplesOpen ? <WorkflowExamplesPopover anchorRef={anchorRef} onRequestClose={() => setExamplesOpen(false)} onUse={props.onUseExample} /> : null}
        </View>
    );
}

/** The open menu: mounted only while open, so its catalog and library reads happen on demand. */
function WorkflowAddBlockMenuPopover(props: Readonly<{
    composerScope?: AuthoringComposerScope;
    anchorRef: React.RefObject<View | null>;
    onAdd: (request: WorkflowAddBlockRequest) => void;
    onExamples?: () => void;
    onClose: () => void;
    currentWorkflowRef?: string | null;
    testID?: string;
}>): React.ReactElement {
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
                ...(self
                    ? { subtitle: t('workflows.page.blocks.selfRef', { workflow: option.title }), disabled: true }
                    : {}),
                onSelect: add({ kind: 'workflow', workflowRef: option.ref }),
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
        const actionsStep: SelectionListStep = {
            id: 'add-action',
            title: t('workflows.page.blocks.menuAction'),
            inputPlaceholder: t('workflows.page.blocks.actionSearch'),
            sections: [{
                kind: 'static',
                id: 'actions',
                options: catalog.specs.map((spec) => ({
                    id: optionId(`action:${spec.id}`),
                    label: spec.title,
                    subtitle: spec.description ?? t('workflows.page.blocks.noAgentTurn'),
                    onSelect: add({ kind: 'action', actionId: spec.id }),
                })),
            }],
        };
        return {
            id: 'add-root',
            title: t('workflows.editor.add'),
            sections: [
                {
                    kind: 'static',
                    id: 'kinds',
                    options: [
                        { id: optionId('step'), label: t('workflows.editor.addStep'), onSelect: add({ kind: 'step' }) },
                        { id: optionId('workflow'), label: t('workflows.page.blocks.menuRun'), openStep: workflowsStep },
                        { id: optionId('action'), label: t('workflows.page.blocks.menuAction'), openStep: actionsStep },
                        { id: optionId('wait'), label: t('workflows.page.blocks.menuWait'), onSelect: add({ kind: 'wait' }) },
                    ],
                },
                {
                    kind: 'static',
                    id: 'structure',
                    options: [
                        { id: optionId('parallel'), label: t('workflows.editor.addParallel'), onSelect: add({ kind: 'parallel' }) },
                        { id: optionId('loop'), label: t('workflows.editor.addLoop'), onSelect: add({ kind: 'loop' }) },
                        { id: optionId('if'), label: t('workflows.editor.addIf'), onSelect: add({ kind: 'if' }) },
                    ],
                },
                ...(props.onExamples === undefined ? [] : [{ kind: 'static' as const, id: 'examples', options: [
                    { id: optionId('example'), label: t('workflows.examples.title'), onSelect: props.onExamples },
                ] }]),
            ],
        };
    }, [libraryOptions, library.hasMore, library.loadingMore, library.loadMore, library.retry, library.status,
        catalog.specs, onAdd, onClose, props.currentWorkflowRef, props.testID, props.onExamples]);

    return (
        <AgentInputSelectionListPopover
            open
            anchorRef={props.anchorRef}
            rootStep={rootStep}
            onSelect={() => {
                // Each option's own `onSelect` is the action source and closes the menu.
            }}
            onRequestClose={onClose}
            maxHeightCap={480}
            {...(props.testID === undefined ? {} : { testID: `${props.testID}-menu` })}
        />
    );
}
