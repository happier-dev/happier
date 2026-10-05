import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import type { WorkflowStarterExampleV1 } from '@happier-dev/protocol';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { WorkflowExamplesSection } from './WorkflowExamplesSection';

/** S9: one anchored, scrollable picker, also used by the column's + menu. */
export function WorkflowExamplesPopover(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    onUse?: (example: WorkflowStarterExampleV1) => void;
}>): React.ReactElement {
    const router = useRouter();
    // Six cards, each with its map: the picker takes the room the window gives it instead of the
    // menu-sized default, so a card is cut only where the list really continues.
    const { height: windowHeight } = useWindowDimensions();
    return <Popover open anchorRef={props.anchorRef} onRequestClose={props.onRequestClose} placement="auto"
        maxWidthCap={720} maxHeightCap={windowHeight} autoFocusOnOpen portal={{ web: true, native: true, matchAnchorWidth: false }}>
        {({ maxHeight }) => <FloatingOverlay maxHeight={maxHeight} scrollEnabled>
            <WorkflowExamplesSection onUse={(example) => {
                props.onRequestClose();
                if (props.onUse) props.onUse(example);
                else router.push({ pathname: '/workflows/new', params: { example: example.key } } as never);
            }} />
        </FloatingOverlay>}
    </Popover>;
}
