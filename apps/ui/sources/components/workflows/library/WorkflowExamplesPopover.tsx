import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import type { WorkflowStarterExampleSelection, WorkflowStarterSessionTarget } from '@happier-dev/protocol/workflows/builtins/examples';
import { APP_SHELL_TITLE_STRIP_HEIGHT_PX } from '@/components/navigation/shell/appRail/appRailMetrics';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { POPOVER_PREFERRED_ROOM_PX } from '@/components/ui/popover/popoverPreferredRoom';
import { t } from '@/text';
import { WorkflowExamplesSection } from './WorkflowExamplesSection';

/** The list composition is a menu-sized picker; cards with their maps take the room the window gives. */
const LIST_POPOVER_MAX_WIDTH_PX = 440;
// The picker is tall: it keeps a margin from every window edge, and clear of the window's title strip above.
const EDGE_PADDING = { horizontal: 8, top: APP_SHELL_TITLE_STRIP_HEIGHT_PX + 8, bottom: 8 } as const;

/**
 * S9: one anchored, scrollable picker, also used by the column's + menu and a Session's Triggers "+". On a
 * phone it is the shared bottom sheet (lab `b-habit Ep`), titled by the sheet header instead of the section.
 */
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
        phonePresentation="sheet" accessibilityLabel={t('workflows.examples.title')}
        maxWidthCap={list ? LIST_POPOVER_MAX_WIDTH_PX : 720} maxHeightCap={windowHeight}
        placementMinSpace={POPOVER_PREFERRED_ROOM_PX} autoFocusOnOpen
        // The whole catalog is taller than most windows: the picker keeps a margin from every window
        // edge and scrolls inside instead of running past the top or bottom (lab `b-habit T`).
        edgePadding={EDGE_PADDING}
        // A Session's picker is a one-line-per-example list: it is content-sized up to the shared compact
        // width, so a description takes two lines at most (lab `b-habit T`). The card picker keeps its room.
        portal={{ web: true, native: true, matchAnchorWidth: false, ...(list ? { sizeToContent: true } : {}) }}>
        {/* Rows under the list ("New trigger") stay at the picker's foot while the examples scroll. */}
        {({ maxHeight, presentation }) => <FloatingOverlay maxHeight={maxHeight} scrollEnabled footer={props.footer}><View testID={props.testID}>
            <WorkflowExamplesSection onUse={props.onUse} onDidUse={props.onRequestClose} hideTitle={presentation === 'sheet'}
                {...(list ? { session: props.session, presentation: 'list' as const } : {})} />
        </View></FloatingOverlay>}
    </Popover>;
}
