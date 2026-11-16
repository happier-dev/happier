import * as React from 'react';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { usePresentedDetailNavigationChrome, type DetailNavigationMainColumnControls } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { registerShellColumnActionOwner, notifyShellColumnActionOwnersChanged, type ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { useDestinationFocusSignal } from '@/components/appShell/workspace/destinationInstanceContext';
import { followSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { RightSidebarActions } from '@/components/appShell/rightSidebar/rightSidebarActions';
import { useOptionalAppPaneScopeLayout } from './hooks/useAppPaneScopeLayout';
import { createPaneMainChipClaims, PaneMainChipClaimsContext, PaneMainColumnContext, type PaneMainColumnDescriptor, type PaneMainColumnState } from './mainColumn/usePaneMainColumn';
import { PaneMainRestoreFallback } from './mainColumn/PaneMainColumnControls';
import type { PaneSurfaceScope } from './types';

/** Measured host controls: one raw Action terminal and admitted explicit commands. */
export function AppPaneScopeControls(props: Readonly<{
    scopeId: string;
    surfaceScope?: PaneSurfaceScope | null;
    descriptor?: PaneMainColumnDescriptor;
    rightOpen: boolean;
    detailsOpen: boolean;
    sideAvailable: boolean;
    arrangementHonoured: boolean;
    onControlsChange?: (controls: PaneMainColumnState | null) => void;
    setHidden: (hidden: boolean) => void;
    setSideVisible: (visible: boolean) => void;
    sideActions: React.MutableRefObject<RightSidebarActions | null>;
    children: React.ReactNode;
}>) {
    const layout = useOptionalAppPaneScopeLayout();
    const detailNavigation = usePresentedDetailNavigationChrome();
    const folded = layout?.layout.main === 'overlay';
    const hidden = layout?.mainHidden === true || (folded && !layout?.mainDrawerOpen);
    const canHide = props.descriptor !== undefined && layout != null
        && layout.layout.kind !== 'single' && (props.rightOpen || layout.effectiveDetailsOpen || props.detailsOpen);
    const labels = React.useMemo(() => ({
        hideLabel: props.descriptor?.hideLabel ?? '', showLabel: props.descriptor?.showLabel ?? '',
    }), [props.descriptor?.hideLabel, props.descriptor?.showLabel]);
    const current = React.useRef({ props, layout, hidden, canHide, labels, detailNavigation });
    current.current = { props, layout, hidden, canHide, labels, detailNavigation };
    const readPhysicalMain = React.useCallback((): DetailNavigationMainColumnControls => {
        const { props, layout, hidden, canHide, labels } = current.current;
        const checkout = props.surfaceScope?.targetKind === 'project'
            ? props.surfaceScope.projectContext?.target?.checkout : undefined;
        const accountId = props.surfaceScope?.accountLifetime?.scope.accountId;
        return {
            present: true, visible: props.descriptor === undefined || !hidden,
            available: canHide || props.sideActions.current?.main !== undefined,
            label: props.descriptor === undefined ? undefined : hidden ? labels.showLabel : labels.hideLabel,
            arrangementAvailable: props.arrangementHonoured && layout?.multiPaneEnabled === true && layout.deviceType !== 'phone',
            ...(checkout && accountId ? { searchScope: {
                accountId, serverId: checkout.serverId, machineId: checkout.machineId,
                rootPath: checkout.rootPath, sessionId: null,
            } } : {}),
            setVisible: visible => props.setHidden(!visible),
        };
    }, []);
    const readMain = React.useCallback((): ShellColumnActionOwner => {
        const { props, detailNavigation } = current.current;
        return detailNavigation ? detailNavigation.readColumn('main')
            : { ...(props.sideActions.current?.main ?? {}), ...readPhysicalMain() };
    }, [readPhysicalMain]);
    const readSide = React.useCallback((): ShellColumnActionOwner => {
        const { props, layout, detailNavigation } = current.current;
        if (detailNavigation && detailNavigation.registerSide !== false) return detailNavigation.readColumn('side');
        return {
            present: true, visible: props.rightOpen,
            available: props.sideAvailable && layout?.multiPaneEnabled === true && layout.deviceType !== 'phone',
            ...(props.sideActions.current ?? {}), setVisible: props.setSideVisible,
        };
    }, []);
    const execute = useMountedScopeActionCommand(useActiveServerAccountScope());
    const requestHidden = React.useCallback((hidden: boolean) =>
        execute('shell.column.set', { column: 'main', visible: !hidden }, { kind: 'shell.column', column: 'main', read: readMain }), [execute, readMain]);
    const requestToggle = React.useCallback(() => requestHidden(!hidden), [hidden, requestHidden]);
    // Semantic presentation/hydration retains the host's raw setter; buttons and keys use requestHidden.
    const setHidden = props.setHidden;
    const value = React.useMemo<PaneMainColumnState | null>(() => props.descriptor === undefined ? null : ({
        hidden, canHide, folded, labels, identity: props.descriptor.identity, setHidden, requestHidden, toggle: requestToggle,
    }), [canHide, folded, hidden, labels, props.descriptor?.identity, setHidden, requestHidden, requestToggle]);
    React.useLayoutEffect(() => {
        props.onControlsChange?.(value);
        return () => props.onControlsChange?.(null);
    }, [props.onControlsChange, value]);
    const arrangementAvailable = props.arrangementHonoured && layout?.multiPaneEnabled === true && layout.deviceType !== 'phone';
    // The destination's focus owns these registrations by subscription: a tab switch does not render the
    // pane scope.
    const focus = useDestinationFocusSignal();
    React.useEffect(() => followSignal(focus, (focused) => {
        if (focused) notifyShellColumnActionOwnersChanged();
    }), [arrangementAvailable, focus]);
    React.useEffect(() => {
        if (layout?.deviceType === 'phone') return;
        return followSignal(focus, (focused) => {
            if (!focused) return;
            // Read through the ref: no closure here may capture a render's `detailNavigation`. On a remount
            // the first render still sees the previous page's model, and the stable callbacks above share
            // this render's closure scope, so capturing it would pin every earlier page in a chain.
            const { detailNavigation } = current.current;
            const unregisterMain = detailNavigation ? detailNavigation.bindMainColumn(readPhysicalMain)
                : registerShellColumnActionOwner('main', readMain);
            const unregisterSide = !detailNavigation || detailNavigation.registerSide === false
                ? registerShellColumnActionOwner('side', readSide) : () => {};
            return () => { unregisterMain(); unregisterSide(); };
        });
    }, [focus, layout?.deviceType, props.scopeId, readMain, readPhysicalMain, readSide,
        detailNavigation?.bindMainColumn, detailNavigation?.registerSide]);
    useKeyboardShortcutHandlers(React.useMemo(() => ({
        'panes.main.toggle': () => { if (!canHide) return false; void requestToggle(); return true; },
        'panes.side.toggle': () => {
            if (!props.sideAvailable || !layout?.multiPaneEnabled || layout.deviceType === 'phone') return false;
            void execute('shell.column.set', { column: 'side', visible: !props.rightOpen }, { kind: 'shell.column', column: 'side', read: readSide });
            return true;
        },
    }), [canHide, execute, layout?.deviceType, layout?.multiPaneEnabled, props.rightOpen, props.sideAvailable, readSide, requestToggle]), focus);
    const [chipClaims] = React.useState(createPaneMainChipClaims);
    return <PaneMainColumnContext.Provider value={value}>
        <PaneMainChipClaimsContext.Provider value={chipClaims}>
            {props.children}
            <PaneMainRestoreFallback />
        </PaneMainChipClaimsContext.Provider>
    </PaneMainColumnContext.Provider>;
}
