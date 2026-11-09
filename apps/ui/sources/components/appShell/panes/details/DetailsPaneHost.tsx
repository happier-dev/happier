import * as React from 'react';
import { PaneHeaderScrollScope } from '@/components/appShell/panes/paneHeaderScroll';
import { View } from 'react-native';

import { AppScopePaneHost } from '../AppScopePaneHost';
import { PaneHeader, type PaneHeaderContent } from '../PaneHeader';
import { PopoverScope } from '@/components/ui/popover';

/** Content a destination opens in its details pane. Tabs are the content's own business. */
export type DetailsPaneContent = Readonly<{
    /** Optional header band: title, subtitle and actions, with the close button after them. */
    header?: PaneHeaderContent;
    content: React.ReactNode;
    /** Names the pane for assistive technology when there is no header title. */
    accessibilityLabel?: string;
    /** A companion beside the page's own content (an Environment's Logs), not an item of a list: the page stays. */
    companion?: true;
    /** An item opened over the page (a Board's card): the page keeps its width, scroll and presses underneath. */
    overPage?: true;
}>;

export type DetailsPaneHostProps = Readonly<{
    main: React.ReactNode;
    mainColumn?: React.ComponentProps<typeof AppScopePaneHost>['mainColumn'];
    onMainColumnControlsChange?: React.ComponentProps<typeof AppScopePaneHost>['onMainColumnControlsChange'];
    /** What the details pane shows; null closes it. The destination owns this selection. */
    details: DetailsPaneContent | null;
    /** The pane asks to close (its close button, Escape, or a tap on the overlay scrim). */
    onCloseDetails: () => void;
    /**
     * The main content's own minimum width. Widening the pane past the point where main would be
     * narrower turns the pane into an overlay. Defaults to the canonical main minimum.
     */
    mainMinWidthPx?: number;
    detailsPreferredWidthPx?: number;
    testID?: string;
}>;

/** The same detail boundary and header inside either an App or Project physical pane host. */
export const DetailsPaneContentView = React.memo(function DetailsPaneContentView(props: Readonly<{
    details: DetailsPaneContent;
    onClose: () => void;
    testID?: string;
}>) {
    const { details, onClose } = props;
    const testID = props.testID ?? 'details-pane';
    // The details pane (header and body) is the boundary its menus and Add surfaces float inside.
    const paneBoundaryRef = React.useRef<View>(null);
    return (
        <View
            ref={paneBoundaryRef}
            testID={testID}
            style={{ flex: 1, minHeight: 0, minWidth: 0 }}
            accessibilityLabel={details.accessibilityLabel ?? details.header?.title}
        >
            <PopoverScope boundaryRef={paneBoundaryRef}>
            <PaneHeaderScrollScope>
            {details.header ? (
                <PaneHeader
                    testID={`${testID}.header`}
                    mainRestoreChip
                    title={details.header.title}
                    subtitle={details.header.subtitle}
                    line={details.header.line}
                    actions={details.header.actions}
                    lineTrailing={details.header.lineTrailing}
                    onClose={onClose}
                />
            ) : null}
            <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{details.content}</View>
            </PaneHeaderScrollScope>
            </PopoverScope>
        </View>
    );
});

/**
 * A destination's details pane: `main` beside a resizable, full-height details column whose width
 * persists across the app and which becomes an overlay instead of squeezing `main` below its minimum.
 * Selection stays with the destination; the App's right sidebar opens beside the same page.
 * Fresh phone opens push in-page, while an already-selected detail retains this instance.
 */
export const DetailsPaneHost = React.memo(function DetailsPaneHost(props: DetailsPaneHostProps) {
    const { details, onCloseDetails: onClose, testID } = props;
    const destinationDetails = React.useMemo(() => (details ? {
        pane: <DetailsPaneContentView details={details} onClose={onClose} testID={testID} />,
        onClose,
        ...(details.companion ? { companion: true as const } : {}),
        ...(details.overPage ? { overPage: true as const } : {}),
    } : null), [details, onClose, testID]);
    return (
        <AppScopePaneHost
            main={props.main}
            mainColumn={props.mainColumn}
            onMainColumnControlsChange={props.onMainColumnControlsChange}
            destinationDetails={destinationDetails}
            mainMinWidthPx={props.mainMinWidthPx}
            detailsPreferredWidthPx={props.detailsPreferredWidthPx}
        />
    );
});
