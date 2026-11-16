import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

import { SelectionList, resolvePopoverSelectionListHeightBehavior } from '@/components/ui/selectionList';
import type { SelectionListHeightBehavior, SelectionListOptionPresentation, SelectionListSelection, SelectionListStep } from '@/components/ui/selectionList';

import { AgentInputSelectionPopover } from '../selection/AgentInputSelectionPopover';
import { deferAgentInputPopoverClose } from '../selection/deferAgentInputPopoverClose';
import { AgentInputPopoverSurface } from './AgentInputPopoverSurface';

/**
 * Default size caps for SelectionList-driven AgentInput popovers. Keep the
 * shared fallback compact because most chip menus are short lists; wide or
 * unusually tall call sites can still opt into larger caps explicitly.
 */
const DEFAULT_MAX_HEIGHT_CAP = 420;
const DEFAULT_MAX_WIDTH_CAP = 420;
const DEFAULT_TEST_ID = 'agent-input-selection-list-popover';

export type AgentInputSelectionListPopoverProps = Readonly<{
    currentUiContextCommandScope?: string;
    open: boolean;
    anchorRef: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    rootStep: SelectionListStep;
    selectedOptionId?: string | null;
    /** Several choices at once (`kind: 'multiple'`): rows toggle and the popover stays open. */
    selection?: SelectionListSelection;
    onSelect: (id: string, context?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => void;
    onRequestClose: (context?: ActionExecutorContext) => void;
    maxHeightCap?: number;
    maxWidthCap?: number;
    heightBehavior?: SelectionListHeightBehavior;
    /** Preserve the list primitive's declared grid semantics for interactive expanded content. */
    optionsHostInlineControls?: boolean;
    optionPresentation?: SelectionListOptionPresentation;
    testID?: string;
}>;

/**
 * Wrapper that mounts the generic `SelectionList` primitive inside the shared
 * AgentInput popover shell (`AgentInputSelectionPopover` + `AgentInputPopoverSurface`).
 *
 * The popover shell owns:
 *  - anchor positioning + viewport boundary handling
 *  - the maxHeight calculation passed down via the render-prop child
 *  - close-on-outside / placement / portal semantics
 *
 * `AgentInputPopoverSurface` is rendered with `scrollEnabled={false}` because
 * `SelectionList` owns its own scrolling (each section uses `ItemGroup`/
 * `SelectionListVirtualizedSection`, and the orchestrator clamps height via
 * its `maxHeight` prop). Layering another scroll container on top would steal
 * keyboard nav and break the cross-slide measurements.
 */
export function AgentInputSelectionListPopover(props: AgentInputSelectionListPopoverProps): React.ReactElement {
    return (
        <AgentInputSelectionPopover
            open={props.open}
            anchorRef={props.anchorRef}
            boundaryRef={props.boundaryRef}
            onRequestClose={props.onRequestClose}
            maxHeightCap={props.maxHeightCap ?? DEFAULT_MAX_HEIGHT_CAP}
            maxWidthCap={props.maxWidthCap ?? DEFAULT_MAX_WIDTH_CAP}
            // A list that keeps its whole height needs its whole cap: it opens toward the side that holds it.
            {...(props.heightBehavior === 'fixedToMaxHeight' ? { contentRoom: props.maxHeightCap ?? DEFAULT_MAX_HEIGHT_CAP } : {})}
        >
            {({ maxHeight, dismiss }) => (
                <AgentInputPopoverSurface
                    testID={props.testID ?? DEFAULT_TEST_ID}
                    maxHeight={maxHeight}
                    scrollEnabled={false}
                >
                    <SelectionList
                        currentUiContextCommandScope={props.currentUiContextCommandScope}
                        currentUiContextForegroundOverlay
                        rootStep={props.rootStep}
                        {...(props.selection ? { selection: props.selection } : { selectedOptionId: props.selectedOptionId })}
                        autoFocusInputOnWeb
                        onSelect={(id, _option, context, invocation) => {
                            // The caller's onSelect runs synchronously so any
                            // per-row mutation/state update is committed against
                            // the still-valid synthetic event.
                            if (context || invocation) props.onSelect(id, context, invocation);
                            else props.onSelect(id);
                            // A multiple choice toggles in place; only a single choice is terminal.
                            if (props.selection?.kind === 'multiple') return;
                            // FR3-B (FR3-3): on web, closing a portaled popover
                            // synchronously from an option click can allow the
                            // click event to "fall through" to the underlying
                            // chip anchor after the popover unmounts and
                            // immediately re-open it. Defer the close to the
                            // next task so the click fully resolves against the
                            // option row first. On native this calls
                            // onRequestClose synchronously (no portal click
                            // fall-through to guard against).
                            deferAgentInputPopoverClose(context ? () => props.onRequestClose(context) : props.onRequestClose);
                        }}
                        // The list's own close (Escape) is a dismissal; a + menu row's picker then returns to the menu.
                        onRequestClose={dismiss ?? props.onRequestClose}
                        maxHeight={maxHeight}
                        heightBehavior={resolvePopoverSelectionListHeightBehavior(props.heightBehavior)}
                        optionsHostInlineControls={props.optionsHostInlineControls}
                        // A floating chip menu draws edge-to-edge rows like every other menu
                        // (dropdowns, action lists, the command palette), not full-bleed bands.
                        optionPresentation={props.optionPresentation ?? 'menu'}
                    />
                </AgentInputPopoverSurface>
            )}
        </AgentInputSelectionPopover>
    );
}
