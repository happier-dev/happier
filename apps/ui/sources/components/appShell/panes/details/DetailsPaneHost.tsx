import * as React from 'react';
import { View } from 'react-native';

import { AppScopePaneHost } from '../AppScopePaneHost';
import { PaneHeader, type PaneHeaderContent } from '../PaneHeader';

/** Content a destination opens in its details pane. Tabs are the content's own business. */
export type DetailsPaneContent = Readonly<{
    /** Optional header band: title, subtitle and actions, with the close button after them. */
    header?: PaneHeaderContent;
    content: React.ReactNode;
    /** Names the pane for assistive technology when there is no header title. */
    accessibilityLabel?: string;
}>;

export type DetailsPaneHostProps = Readonly<{
    main: React.ReactNode;
    /** What the details pane shows; null closes it. The destination owns this selection. */
    details: DetailsPaneContent | null;
    /** The pane asks to close (its close button, Escape, or a tap on the overlay scrim). */
    onCloseDetails: () => void;
    /**
     * The main content's own minimum width. Widening the pane past the point where main would be
     * narrower turns the pane into an overlay. Defaults to the canonical main minimum.
     */
    mainMinWidthPx?: number;
    testID?: string;
}>;

/**
 * A destination's details pane: `main` beside a resizable, full-height details column whose width
 * persists across the app (the same width every details pane uses) and which becomes an overlay
 * instead of squeezing `main` below its minimum. Selection stays with the destination: pass the
 * content to open it and null to close it. It stands in the App's pane host, so the App's right
 * sidebar opens beside the same page.
 *
 * Fresh phone opens push a page (`useDetailsPaneAvailable()` is false). An already-selected
 * detail stays in this same instance and takes the full viewport when side panes cannot be shown.
 */
export const DetailsPaneHost = React.memo(function DetailsPaneHost(props: DetailsPaneHostProps) {
    const testID = props.testID ?? 'details-pane';
    const details = props.details;
    const onClose = props.onCloseDetails;
    const destinationDetails = React.useMemo(() => (details ? {
        pane: (
            <View
                testID={testID}
                style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                accessibilityLabel={details.accessibilityLabel ?? details.header?.title}
            >
                {details.header ? (
                    <PaneHeader
                        testID={`${testID}.header`}
                        title={details.header.title}
                        subtitle={details.header.subtitle}
                        line={details.header.line}
                        actions={details.header.actions}
                        onClose={onClose}
                    />
                ) : null}
                <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{details.content}</View>
            </View>
        ),
        onClose,
    } : null), [details, onClose, testID]);
    return (
        <AppScopePaneHost
            main={props.main}
            destinationDetails={destinationDetails}
            mainMinWidthPx={props.mainMinWidthPx}
        />
    );
});
