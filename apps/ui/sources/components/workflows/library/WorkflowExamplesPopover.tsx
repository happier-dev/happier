import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import type { WorkflowStarterExampleSelection, WorkflowStarterSessionTarget } from '@happier-dev/protocol/workflows/builtins/examples';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { WorkflowExamplesSection } from './WorkflowExamplesSection';

/** The list composition is a menu-sized picker; cards with their maps take the room the window gives. */
const LIST_POPOVER_MAX_WIDTH_PX = 440;

/** S9: one anchored, scrollable picker, also used by the column's + menu and a Session's Triggers "+". */
export function WorkflowExamplesPopover(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    onUse?: (example: WorkflowStarterExampleSelection) => void;
    /** A Session's Triggers "+": its examples, already bound to it (65s5). */
    session?: WorkflowStarterSessionTarget;
    /** Rows under the list, such as the Session's own "New trigger". */
    footer?: React.ReactNode;
    testID?: string;
}>): React.ReactElement {
    // Cards with their maps: the picker takes the room the window gives it instead of the
    // menu-sized default, so a card is cut only where the list really continues.
    const { height: windowHeight } = useWindowDimensions();
    const list = props.session !== undefined;
    return <Popover open anchorRef={props.anchorRef} onRequestClose={props.onRequestClose} placement="auto"
        maxWidthCap={list ? LIST_POPOVER_MAX_WIDTH_PX : 720} maxHeightCap={windowHeight} autoFocusOnOpen
        portal={{ web: true, native: true, matchAnchorWidth: false }}>
        {({ maxHeight }) => <FloatingOverlay maxHeight={maxHeight} scrollEnabled><View testID={props.testID}>
            <WorkflowExamplesSection onUse={props.onUse} onDidUse={props.onRequestClose}
                {...(list ? { session: props.session, presentation: 'list' as const } : {})} />
            {props.footer}
        </View></FloatingOverlay>}
    </Popover>;
}
