import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View, type TextInput as NativeTextInput } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { InlineTextField, type InlineTextEditor } from '@/components/ui/text/InlineTextField';
import type { WorkflowUnnamedHeading } from '@/sync/domains/workflows/workflowBlockLabel';
import { t } from '@/text';

import { WorkflowBlockActionsMenu, type WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { workflowEditorStyles } from './workflowEditorStyles';

export type WorkflowBlockNameEditor = InlineTextEditor;

/**
 * The one heading every authored block uses: a circled tabular ordinal (filled
 * while the block is selected), the block's kind mark, its name as the control
 * that selects it, its quiet facts, and its overflow actions (lab `.uwe-sh`,
 * `.uwe-ch`). Containers and leaves share it, so the ordinal and mark columns
 * line up at every depth.
 *
 * The name is a caret-only field in the editor and a selection button for readers.
 * Its accessible name carries
 * the block's context and its hint the first validation issue, which is how a
 * screen reader hears "which block, where, and whether it needs repair" at the
 * block boundary without an outer container swallowing the editable prompt.
 */
export function WorkflowBlockHeading(props: Readonly<{
    ordinal: number;
    displayName: string;
    nameEditor?: InlineTextEditor;
    /**
     * Provenance beside a typed card's title ("· Built-in", "· Happier") while the heading carries the
     * card's identity (`unnamed: 'card'`); never beside an authored step name.
     */
    sourceLabel?: string;
    /** Name, position and set size for assistive technology; defaults to the name. */
    accessibilityLabel?: string;
    /** The first issue on this block, when it needs repair. */
    issue?: string | null;
    actions: readonly WorkflowBlockAction[];
    /** Contributed Agent brand or the block kind's glyph, never a backing tile. */
    kindMark?: React.ReactNode;
    /** Whether this block is the selected one: its ordinal fills. */
    selected?: boolean;
    /**
     * The block's visible number from `workflowBlockOrdinalV1` (continuous over the document's leaves,
     * as the map and a step Session's title show it). A container has none (`null`/absent): its kind
     * mark takes the ordinal slot instead (lab E1).
     */
    visibleOrdinal?: string | null;
    /** How the heading reads while the block has no authored name (`resolveWorkflowUnnamedHeading`). */
    unnamed?: WorkflowUnnamedHeading;
    /**
     * Registers this heading as the block's focus target when it has no prompt (an Action, a
     * workflow, a container), so "N things to fix" lands on the block itself (DESIGN-6 P3).
     */
    focusRegistration?: (focus: (() => void) | null) => void;
    /** Quiet facts beside the name (a container's "· 2 lanes", "Repeat 3 times"). */
    meta?: React.ReactNode;
    /** The trailing control before the overflow menu (a container's consequence select). */
    trailing?: React.ReactNode;
    /** The heading line's fixed slot for a reader's facts (a state word, an occurrence selector). */
    accessory?: React.ReactNode;
    onSelect: () => void;
    testID: string;
    actionsTestID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    // A container's name (or a card's title) is sized to its words so its meta follows it ("Side by
    // side · 3 lanes", "Notify me · Happier"); a leaf's name takes the line, as a field does.
    const compound = props.meta !== undefined || props.trailing !== undefined || props.sourceLabel !== undefined;
    const [nameWidth, setNameWidth] = React.useState<number | null>(null);
    const nameControlRef = React.useRef<NativeTextInput | null>(null);
    const { focusRegistration } = props;
    React.useEffect(() => {
        if (focusRegistration === undefined) return undefined;
        focusRegistration(() => nameControlRef.current?.focus());
        return () => focusRegistration(null);
    }, [focusRegistration]);
    // Unnamed, a container's sentence is its title, and a typed card's identity is the heading's own
    // title (its card then shows only its rows), so the heading never says the kind twice and is
    // never an empty row ("Repeat · Repeat 2 times", a bare `⋯` over "Notify me · Happier").
    const sentenceTitle = props.unnamed === 'sentence' && props.meta !== undefined;
    const showsName = props.unnamed !== 'sentence';
    const inkPlaceholder = props.unnamed === 'kind' || props.unnamed === 'card';
    // A narrow line moves the meta beneath the name (07 "Phones recompose"); there it starts with its
    // own words, not the separator that joins it to the name on one line (DESIGN-7 N34). Its own
    // layout says which: beside the name it starts after the name's width, beneath it at the line's
    // start (the name line's inset).
    const [metaWrapped, setMetaWrapped] = React.useState(false);
    const meta = props.meta === undefined ? null : sentenceTitle ? (
        <Text testID={`${props.testID}-meta`} numberOfLines={2} style={[workflowEditorStyles.headingName, { flexShrink: 1 }]}>{props.meta}</Text>
    ) : (
        <Text testID={`${props.testID}-meta`} numberOfLines={2} style={workflowEditorStyles.headingMeta}
            onLayout={(event) => {
                const { x, width } = event.nativeEvent.layout;
                const wrapped = width > 0 && x <= theme.margins.xs + 1;
                setMetaWrapped((current) => (current === wrapped ? current : wrapped));
            }}>
            {metaWrapped ? null : '· '}{props.meta}
        </Text>
    );
    const kindMark = props.kindMark === undefined ? null : (
        <View testID={`${props.testID}-kind-mark`} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {props.kindMark}
        </View>
    );
    const numbered = props.visibleOrdinal !== undefined && props.visibleOrdinal !== null;
    // A numbered leaf keeps its mark beside its name; a container's mark is its ordinal.
    const nameMark = numbered ? kindMark : null;
    const source = props.sourceLabel === undefined ? null
        : <Text testID={`${props.testID}-source`} numberOfLines={1} style={workflowEditorStyles.headingMeta}>{'· '}{props.sourceLabel}</Text>;
    return (
        <View style={workflowEditorStyles.heading}>
            <View style={workflowEditorStyles.headingLine}>
                {numbered ? (
                    <View
                        testID={`${props.testID}-ordinal`}
                        style={[workflowEditorStyles.ordinal, props.selected === true ? workflowEditorStyles.ordinalSelected : null]}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    >
                        <Text style={[workflowEditorStyles.ordinalText, props.selected === true ? workflowEditorStyles.ordinalTextSelected : null]}>
                            {t('workflows.editor.stepOrdinal', { position: Number(props.visibleOrdinal) })}
                        </Text>
                    </View>
                ) : (
                    // A container is unnumbered: its kind mark stands in the ordinal column (no tile).
                    <View testID={`${props.testID}-ordinal-mark`} style={workflowEditorStyles.ordinalMark}
                        accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        {kindMark}
                    </View>
                )}
            </View>
            <View style={workflowEditorStyles.headingMain}>
                {props.nameEditor === undefined ? <HappierPressable
                    testID={props.testID}
                    accessibilityRole="button"
                    accessibilityLabel={[props.accessibilityLabel ?? props.displayName, props.sourceLabel].filter(Boolean).join(' · ')}
                    {...(props.issue === undefined || props.issue === null ? {} : { accessibilityHint: props.issue })}
                    onPress={props.onSelect}
                    style={(state) => [
                        workflowEditorStyles.actionTarget,
                        workflowEditorStyles.headingButton,
                        compound ? null : workflowEditorStyles.headingButtonFill,
                        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                    ]}
                >
                    {nameMark}
                    {showsName ? <Text numberOfLines={compound ? 1 : 2} style={workflowEditorStyles.headingName}>{props.displayName}</Text> : null}
                    {source}
                    {meta}
                </HappierPressable> : (
                    <View style={[workflowEditorStyles.headingButton, compound ? null : workflowEditorStyles.headingButtonFill]}>
                        {nameMark}
                        <InlineTextField editor={{ ...props.nameEditor, testID: props.testID, onFocus: props.onSelect, controlRef: nameControlRef,
                            ...(showsName ? {} : { placeholder: '' }),
                            // The card's own title, exactly as its card would have said it.
                            ...(props.unnamed === 'card' ? { placeholder: props.displayName } : {}),
                            ...(props.issue === undefined || props.issue === null ? {} : { accessibilityHint: props.issue }),
                            accessibilityLabel: props.accessibilityLabel ?? props.nameEditor.accessibilityLabel }}
                            placeholderTone={inkPlaceholder ? 'ink' : 'quiet'}
                            style={[workflowEditorStyles.headingNameInput,
                                compound ? { flexGrow: 0, width: nameWidth ?? undefined, maxWidth: '100%' } : { flex: 1 }]} />
                        {source}
                        {meta}
                    </View>
                )}
                {props.trailing ?? null}
            </View>
            {props.nameEditor !== undefined && compound ? (
                // Sizes the editable name to its words (or its placeholder) at the heading's own width.
                <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                    style={workflowEditorStyles.headingNameMeasure}>
                    <Text testID={`${props.testID}-measure`} style={workflowEditorStyles.headingName}
                        onLayout={(event) => setNameWidth(Math.ceil(event.nativeEvent.layout.width) + theme.margins.xs)}>
                        {props.nameEditor.value.length > 0 ? props.nameEditor.value
                            : props.unnamed === 'card' ? props.displayName : showsName ? props.nameEditor.placeholder : ''}
                    </Text>
                </View>
            ) : null}
            <View style={[workflowEditorStyles.headingLine, workflowEditorStyles.headingActions]}>
                {props.accessory ?? null}
                <WorkflowBlockActionsMenu
                    blockLabel={props.displayName}
                    actions={props.actions}
                    testID={props.actionsTestID}
                />
            </View>
        </View>
    );
}
