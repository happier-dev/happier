import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

import { ModalPaneBoundaryView, resolvePaneUnderlayAccessibilityProps } from './ModalPaneBoundary';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/**
 * The main column's composer, as the pane host sees it: a pane presented inside the session column
 * (lab AR1 EFv) covers the column down to the composer's top edge, so the composer stays in reach.
 */
export const PaneMainComposerReporterContext = React.createContext<((node: View | null) => void) | null>(null);

/**
 * The main column's top chrome (a Session's header and its page tabs): a page presented inside the
 * column starts under it, so switching pages never moves the identity or the tabs.
 */
export const PaneMainTopReporterContext = React.createContext<((node: View | null) => void) | null>(null);

/** The pane owner withdraws the covered body, not the composer's still-visible band. */
export const PaneMainBodyPresentationContext = React.createContext<boolean | null>(null);

export function usePaneMainBodyPresentation() {
    const presented = React.useContext(PaneMainBodyPresentationContext);
    return {
        presented,
        hiddenProps: presented === false ? resolvePaneUnderlayAccessibilityProps(true, Platform.OS === 'web') : {},
    };
}

/** Replaces an existing body/header View without hiding or remounting its retained content. */
export function PaneMainBody(props: React.ComponentProps<typeof ModalPaneBoundaryView>): React.ReactElement {
    const { presented, hiddenProps } = usePaneMainBodyPresentation();
    const body = <ModalPaneBoundaryView {...props} {...hiddenProps}
        suppressDescendantPaneBoundaries={props.suppressDescendantPaneBoundaries || presented === false} />;
    // Outside a pane host, do not invent focus authority for a standalone surface.
    if (presented === null) return body;
    return <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
        {body}
    </PluginSurfaceFocusEligibilityProvider>;
}

/** The main column's top chrome; reports itself to the enclosing pane host on every layout. */
export function PaneMainTopAnchor(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const report = React.useContext(PaneMainTopReporterContext);
    const ref = React.useRef<View | null>(null);
    const onLayout = React.useCallback(() => report?.(ref.current), [report]);
    React.useEffect(() => () => report?.(null), [report]);
    return <View ref={ref} onLayout={onLayout}>{props.children}</View>;
}

/** The main column's composer band; reports itself to the enclosing pane host on every layout. */
export function PaneMainComposerAnchor(props: Readonly<{ style?: StyleProp<ViewStyle>; children: React.ReactNode }>): React.ReactElement {
    const report = React.useContext(PaneMainComposerReporterContext);
    const ref = React.useRef<View | null>(null);
    const onLayout = React.useCallback(() => report?.(ref.current), [report]);
    React.useEffect(() => () => report?.(null), [report]);
    return <View ref={ref} onLayout={onLayout} style={props.style}>{props.children}</View>;
}
