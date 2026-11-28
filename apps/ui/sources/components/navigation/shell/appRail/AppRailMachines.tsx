import * as React from 'react';

import { useMachinesRailSeen, writeMachinesRailSeen } from '@/sync/domains/state/machineAdministrationUiState';
import { t } from '@/text';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

import { SidebarFooterPopoverButton, type SidebarFooterDestination, type SidebarFooterPopoverContentProps, type SidebarFooterPopoverTrigger } from '../sidebarFooter/SidebarFooterPopoverButton';
import { SidebarMachinesPopoverContent } from '../sidebarFooter/SidebarMachinesPopoverContent';
import { RAIL_POPOVER_ROSTER_MAX_HEIGHT_PX, RAIL_POPOVER_WIDE_WIDTH_PX } from '../sidebarFooter/sidebarFooterLayout';
import { AppRailBadge, AppRailMenuCount } from './AppRailBadge';
import { AppRailIcon } from './AppRailIcon';
import { AppRailSlot } from './AppRailSlot';
import { APP_RAIL_ICON_GLYPH_SIZE_PX, APP_RAIL_ITEM_EDGES_PX, APP_RAIL_ITEM_SIZE_PX } from './appRailMetrics';
import { buildMachinesRailSeen, forgetRecoveredMachinesRailReasons, useMachinesRailSignal } from './useMachinesRailSignal';

/**
 * The rail's Machines icon (lab `rm` I). Closed, it reads only the string-keyed fleet attention, what this
 * device has seen, and presence counts: a count when machines need you, an amber dot for a new "worth a
 * look", a muted dot when the guard acted since the popover was opened, nothing when calm or offline (R4).
 * The tooltip names the machine and its reason. Opening the popover records what was seen (MPG-16).
 */
export const AppRailMachines = React.memo(function AppRailMachines(props: Readonly<{
    destination: SidebarFooterDestination;
    renderTrigger?: SidebarFooterPopoverTrigger;
    /** The Machines page is open through the rail door (`/machines/**`): the icon is the selected destination (R1). */
    selected?: boolean;
}>) {
    const rail = useMachinesRailSignal();
    const seen = useMachinesRailSeen(rail.fleet.accountScope);
    const scopeKey = rail.fleet.accountScope ? serverAccountScopeKeySuffix(rail.fleet.accountScope) : null;
    const title = t('settings.machines');
    const label = rail.detail ? `${title} · ${rail.detail}` : title;
    const fleetRef = React.useRef(rail.fleet);
    fleetRef.current = rail.fleet;
    // "Since you last looked" compares against the opening before this one, read before this one records itself.
    const seenRef = React.useRef(seen);
    seenRef.current = seen;
    const previousFleetRef = React.useRef(rail.fleet);
    React.useEffect(() => {
        const previous = previousFleetRef.current;
        previousFleetRef.current = rail.fleet;
        // A real reporting transition clears recovered reasons. Mounting or changing Account/Home
        // establishes no recovery fact about the previously observed scope.
        if (previous === rail.fleet || !areServerAccountScopesEqual(previous.accountScope, rail.fleet.accountScope)) return;
        const next = forgetRecoveredMachinesRailReasons(rail.fleet, seenRef.current);
        if (next !== seenRef.current) writeMachinesRailSeen(rail.fleet.accountScope, next);
    }, [rail.fleet]);
    const previousGuardSeenAtRef = React.useRef({ scopeKey, at: seen.guardSeenAt });
    if (previousGuardSeenAtRef.current.scopeKey !== scopeKey) previousGuardSeenAtRef.current = { scopeKey, at: seen.guardSeenAt };
    const recordSeen = React.useCallback(() => {
        const scope = fleetRef.current.accountScope;
        previousGuardSeenAtRef.current = { scopeKey: scope ? serverAccountScopeKeySuffix(scope) : null, at: seenRef.current.guardSeenAt };
        writeMachinesRailSeen(scope, buildMachinesRailSeen(fleetRef.current, Date.now()));
    }, []);
    const renderMachines = React.useCallback((content: SidebarFooterPopoverContentProps) => (
        <SidebarMachinesPopoverContent {...content} guardSeenAt={previousGuardSeenAtRef.current.at} />
    ), []);
    const renderIcon = React.useCallback((open: boolean) => <AppRailIcon name="desktop" active={open || props.selected === true} />, [props.selected]);
    const signal = rail.signal;
    const menuTrigger: SidebarFooterPopoverTrigger | undefined = props.renderTrigger ? state => props.renderTrigger?.({ ...state,
        right: signal?.kind === 'count' ? <AppRailMenuCount tone={signal.tone} value={signal.value} /> : undefined,
    }) : undefined;
    const button = (
        <SidebarFooterPopoverButton
            testID="app-rail-machines"
            destination={props.destination}
            iconName="desktop"
            renderIcon={renderIcon}
            label={label}
            placement="right"
            buttonSizePx={APP_RAIL_ITEM_SIZE_PX}
            interactiveTargetEdgesPx={APP_RAIL_ITEM_EDGES_PX}
            iconSizePx={APP_RAIL_ICON_GLYPH_SIZE_PX}
            popoverWidthPx={RAIL_POPOVER_WIDE_WIDTH_PX}
            popoverMaxHeightPx={RAIL_POPOVER_ROSTER_MAX_HEIGHT_PX}
            renderContent={renderMachines}
            renderTrigger={menuTrigger}
            selected={props.selected}
            hoverPreview
            onOpenIntent={recordSeen}
        />
    );
    if (props.renderTrigger) return button;
    return <AppRailSlot href={props.destination.href} badge={signal ? <AppRailBadge testID="app-rail-machines-badge" signal={signal} /> : null}>{button}</AppRailSlot>;
});
