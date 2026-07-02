import * as React from 'react';

import { SelectionList, resolvePopoverSelectionListHeightBehavior } from '@/components/ui/selectionList';
import type { SelectionListHeightBehavior, SelectionListStep } from '@/components/ui/selectionList';

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
    open: boolean;
    anchorRef: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    rootStep: SelectionListStep;
    selectedOptionId?: string | null;
    onSelect: (id: string) => void;
    onRequestClose: () => void;
    maxHeightCap?: number;
    maxWidthCap?: number;
    heightBehavior?: SelectionListHeightBehavior;
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
        >
            {({ maxHeight }) => (
                <AgentInputPopoverSurface
                    testID={props.testID ?? DEFAULT_TEST_ID}
                    maxHeight={maxHeight}
                    scrollEnabled={false}
                >
                    <SelectionList
                        rootStep={props.rootStep}
                        selectedOptionId={props.selectedOptionId}
                        autoFocusInputOnWeb
                        onSelect={(id) => {
                            // The caller's onSelect runs synchronously so any
                            // per-row mutation/state update is committed against
                            // the still-valid synthetic event.
                            props.onSelect(id);
                            // FR3-B (FR3-3): on web, closing a portaled popover
                            // synchronously from an option click can allow the
                            // click event to "fall through" to the underlying
                            // chip anchor after the popover unmounts and
                            // immediately re-open it. Defer the close to the
                            // next task so the click fully resolves against the
                            // option row first. On native this calls
                            // onRequestClose synchronously (no portal click
                            // fall-through to guard against).
                            deferAgentInputPopoverClose(props.onRequestClose);
                        }}
                        onRequestClose={props.onRequestClose}
                        maxHeight={maxHeight}
                        heightBehavior={resolvePopoverSelectionListHeightBehavior(props.heightBehavior)}
                    />
                </AgentInputPopoverSurface>
            )}
        </AgentInputSelectionPopover>
    );
}
