import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';

import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginExecutionOriginActionOutputSchemas } from '@happier-dev/protocol/actions/pluginExecutionOriginActionFamily';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { accountSettingsScopeKeySuffix, areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import { linkMachineActivity } from '@/sync/domains/machines/machineActivity';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { PluginPresentedExecutionOriginProjectionDemand, readPluginPresentedExecutionOriginProjectionTargets } from '@/sync/domains/machines/administration/usePluginExecutionOriginProjectionDemand';

import type {
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { ServerScopedMachineSelector } from '@/components/sessions/new/components/ServerScopedMachineSelector';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { resolvePluginExecutionOriginReasonDetail as originReasonDetail } from '@/sync/domains/surfaces/copy';
import { resolveMachineAdministrationTargetLabel, type MachineAdministrationCandidateV1 } from '@/sync/domains/machines/administration/targetSelection';
import {
    getPluginExecutionOriginCandidateOrigin,
    getPluginExecutionOriginCandidateVersion,
    isPluginMachineExecutionOriginCandidateSelectable,
    type PluginExecutionOriginCandidateV1,
} from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import {
    type PluginExecutionOriginSelectionMutationResult,
    type PluginMachineExecutionOriginSelectionV1,
    type PluginExecutionOriginPreferenceApproval,
} from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';

type PreferenceActionSettlement = ReturnType<typeof PluginExecutionOriginActionOutputSchemas['plugins.execution_origin.set']['parse']>;
const EMPTY_MACHINE_CANDIDATES: readonly MachineAdministrationCandidateV1[] = Object.freeze([]);
type PluginOriginPickerState = readonly [boolean, React.Dispatch<React.SetStateAction<boolean>>];
type PluginOriginProjectionTarget = MachineAdministrationTargetV1;
const PluginOriginPickerStateContext = React.createContext<Readonly<{
    pluginId: string;
    state: PluginOriginPickerState;
    presentTargets: (targets: readonly PluginOriginProjectionTarget[]) => void;
}> | null>(null);

/** Open the existing page-owned picker without creating a second presenter. */
export function usePluginMachineExecutionOriginPickerOpener(pluginId: string): (() => void) | null {
    const picker = React.useContext(PluginOriginPickerStateContext);
    const setOpen = picker?.pluginId === pluginId ? picker.state[1] : null;
    return React.useMemo(() => setOpen ? () => setOpen(true) : null, [setOpen]);
}

/** Page-owned presentation survives replacement of a loading header by its renderer. */
export function PluginMachineExecutionOriginPickerProvider(props: React.PropsWithChildren<{ pluginId: string; visible?: boolean }>) {
    const [{ open, targets }, setPicker] = React.useState<Readonly<{
        open: boolean; targets: readonly PluginOriginProjectionTarget[];
    }>>({ open: false, targets: [] });
    const setOpen = React.useCallback<React.Dispatch<React.SetStateAction<boolean>>>(update => {
        setPicker(previous => {
            const open = typeof update === 'function' ? update(previous.open) : update;
            return previous.open === open ? previous : { open, targets: open ? previous.targets : [] };
        });
    }, []);
    const presentTargets = React.useCallback((next: readonly PluginOriginProjectionTarget[]) => {
        setPicker(previous => {
            if (!previous.open) return previous;
            return previous.targets === next ? previous : { ...previous, targets: next };
        });
    }, []);
    const value = React.useMemo(() => ({ pluginId: props.pluginId, state: [open, setOpen] as const, presentTargets }),
        [open, presentTargets, props.pluginId, setOpen]);
    // The page keeps the open intent acquired while physical headers hand it
    // off. A new presenter may still revalidate a settled failure; the shared
    // loader joins its read without cancelling this page's pending acquisition.
    return <PluginOriginPickerStateContext.Provider value={value}>
        {open && props.visible !== false ? <PluginPresentedExecutionOriginProjectionDemand key={props.pluginId} targets={targets} /> : null}
        {props.children}
    </PluginOriginPickerStateContext.Provider>;
}

/** Mount Artifact result custody only for an intent actually awaiting review. */
function PluginOriginApprovalNotice(props: Readonly<{
    pending: PluginExecutionOriginPreferenceApproval;
    presentation: 'row' | 'inline';
    testID?: string;
    onFinished: (result: PreferenceActionSettlement | null) => void;
    onScopeChanged: () => void;
}>) {
    const router = useRouter();
    const currentScope = useAccountSettingsScope();
    const pending = props.pending;
    const approval = useActionApprovalContinuation({
        scopeKey: accountSettingsScopeKeySuffix(pending.scope), serverId: pending.scope.serverId,
        // The settings mutation already publishes its canonical store projection.
        onExecuted: () => {},
    });
    React.useEffect(() => {
        if (currentScope && !areAccountSettingsScopesEqual(currentScope, pending.scope)) props.onScopeChanged();
    }, [currentScope, pending.scope, props.onScopeChanged]);
    React.useEffect(() => {
        approval.requestApproval(createActionApprovalContinuation({
            artifactId: pending.approval.artifactId, actionId: pending.approval.actionId,
            scope: pending.scope, expectedInput: pending.input, refreshAfterExecution: false,
            onSucceeded: (result: PreferenceActionSettlement) => props.onFinished(result),
            onFailed: () => props.onFinished(null),
        }));
    }, [approval.requestApproval, pending, props.onFinished]);
    const href = buildApprovalHref(pending.approval.artifactId, pending.scope.serverId);
    return <ActionApprovalPendingNotice testID={props.testID} presentation={props.presentation}
        message={t('approvals.waitingForYou')} summary={approval.approvalSummary}
        onOpenApproval={() => router.pushRetainingCurrent(href)} />;
}

type PresentedPluginOrigin = ServerScopedMachinePresentation & Readonly<{
    candidate: PluginExecutionOriginCandidateV1;
    origin: PluginMachineExecutionOriginV1;
}>;

function exactOriginKey(origin: PluginMachineExecutionOriginV1): string {
    return JSON.stringify(origin);
}

function exactOriginsEqual(
    left: PluginMachineExecutionOriginV1 | null,
    right: PluginMachineExecutionOriginV1,
): boolean {
    return left !== null && arePluginMachineExecutionOriginsEqual(left, right);
}

/**
 * A row with a real Machine record already states connectivity in its presence line (the shared
 * owner `describeMachinePresenceLine`), so the plugin observation must not state it a second time:
 * "Online · Last known, machine offline" is two truths, and "Can't reach from this Home · This machine
 * can't be reached from this Home" is one truth said twice. A source without a Machine record has no
 * presence line and keeps its own obstruction.
 */
function resolvePickerRowDetail(machine: PresentedPluginOrigin): string {
    const candidate = machine.candidate;
    const reason = candidate.validation.kind === 'rejected' ? candidate.validation.reason : null;
    // `home_unreachable` is read from the same Home reachability observation the shared status line states
    // ("Can't reach from this Home", or "Offline" when the machine itself is gone), with or without a Machine record.
    if (candidate.releaseContent !== 'conflict'
        && (reason === 'home_unreachable' || (machine.presence !== null && (reason === 'offline' || reason === 'stale')))) {
        return `${t('common.version')} ${getPluginExecutionOriginCandidateVersion(candidate)}`;
    }
    return resolveCandidatePresentationDetail(candidate);
}

function resolvePickerRowPresentation(machine: PresentedPluginOrigin) {
    return { subtitle: resolvePickerRowDetail(machine) };
}

function resolveCandidatePresentationDetail(candidate: PluginExecutionOriginCandidateV1): string {
    const version = `${t('common.version')} ${getPluginExecutionOriginCandidateVersion(candidate)}`;
    if (candidate.releaseContent === 'conflict') {
        return `${t('settingsPlugins.executionOriginReleaseContentConflict')} · ${version}`;
    }
    return isPluginMachineExecutionOriginCandidateSelectable(candidate)
        ? version
        : `${originReasonDetail(candidate.validation.kind === 'rejected' ? candidate.validation.reason : 'unknown')} · ${version}`;
}

function buildOriginGroups(
    candidates: readonly PluginExecutionOriginCandidateV1[],
    machineCandidates: readonly MachineAdministrationCandidateV1[],
    machineRecords: readonly (Machine | null)[],
): readonly ServerScopedMachineGroup<PresentedPluginOrigin>[] {
    const groups = new Map<string, PresentedPluginOrigin[]>();
    for (const [index, candidate] of candidates.entries()) {
        const origin = getPluginExecutionOriginCandidateOrigin(candidate);
        const ref = getPluginMachineExecutionOriginRef(origin);
        const labels = resolveMachineAdministrationTargetLabel({ target: { serverIdentityId: origin.serverIdentityId, machineId: ref.machineId }, candidates: machineCandidates })!;
        const machine = machineRecords[index];
        const rows = groups.get(origin.serverIdentityId) ?? [];
        const presented = Object.freeze({
            ...(machine ? buildMachineDisplayRenderableFromMachine(machine) : {
                // Required row-shape defaults carry no presence authority without a Machine record.
                presence: null,
                updatedAt: 0,
                active: false,
                activeAt: 0,
                metadataVersion: 0,
            }),
            id: ref.machineId,
            serverId: origin.serverIdentityId,
            serverName: labels.server,
            // The machine id is not a host: naming it one would print the opaque id as the row's
            // subtitle and as the hint that tells same-named machines apart.
            metadata: Object.freeze({ displayName: labels.machine }),
            candidate,
            origin,
        });
        if (machine) linkMachineActivity(machine, presented);
        rows.push(presented);
        groups.set(origin.serverIdentityId, rows);
    }
    return Object.freeze([...groups.entries()].map(([serverIdentityId, machines]) => Object.freeze({
        serverId: serverIdentityId,
        serverName: machines[0]!.serverName,
        machines,
        loading: false,
        signedOut: false,
    })));
}

/** Join presence only while the shared picker is mounted. */
function PluginOriginPickerGroups(props: Readonly<{
    candidates: readonly PluginExecutionOriginCandidateV1[];
    machineCandidates: readonly MachineAdministrationCandidateV1[];
    children: (groups: readonly ServerScopedMachineGroup<PresentedPluginOrigin>[]) => React.ReactNode;
}>) {
    const machines = getStorage()(useShallow((state) => props.candidates.map((candidate) => {
        const origin = getPluginExecutionOriginCandidateOrigin(candidate);
        const machine = resolveServerScopedMachine(state, origin.serverIdentityId, getPluginMachineExecutionOriginRef(origin).machineId);
        return machine;
    })));
    const knownMachines = React.useMemo(() => machines.filter((machine): machine is Machine => machine !== null), [machines]);
    // Presented rows share the admitted Machine's activity clock. The canonical
    // deadline owner reschedules continuing beats without rebuilding provenance.
    const nowMs = useMachinePresenceNowMs(knownMachines);
    const groups = React.useMemo(() => buildOriginGroups(props.candidates, props.machineCandidates, machines),
        [props.candidates, props.machineCandidates, machines, nowMs]);
    return <>{props.children(groups)}</>;
}

export type PluginMachineExecutionOriginPresentation = Readonly<{
    title: string;
    /** `title` in its two parts, for a one-line chip: the name shortens, the telling suffix stays whole. */
    titleParts?: Readonly<{ name: string; hint: string | null }>;
    subtitle?: string;
    detail: string;
    selected: boolean;
    /** A chosen Machine that cannot run this plugin's operations now (offline, unreachable, rejected). */
    unavailable?: boolean;
    presence?: 'offline';
    /** Happier picked this Machine (nothing is pinned on this device); choosing one pins it. */
    automatic?: boolean;
}>;

/** The one presentation for remembered Machine intent and current operation custody. */
export function resolvePluginMachineExecutionOriginPresentation(
    selection: PluginMachineExecutionOriginSelectionV1,
    machineCandidates: readonly MachineAdministrationCandidateV1[] = selection.machineCandidates ?? EMPTY_MACHINE_CANDIDATES,
): PluginMachineExecutionOriginPresentation {
    const selectedOrigin = selection.selectedOrigin
        ?? (selection.state.kind === 'selected' ? selection.state.origin : null);
    const selectedTarget = selection.storedTarget
        ?? (selection.state.kind === 'unavailable' ? selection.state.storedTarget : null)
        ?? (selectedOrigin ? { serverIdentityId: selectedOrigin.serverIdentityId, machineId: getPluginMachineExecutionOriginRef(selectedOrigin).machineId } : null);
    if (selectedTarget) {
        const labels = resolveMachineAdministrationTargetLabel({ target: selectedTarget, candidates: machineCandidates })!;
        const machine = machineCandidates.find(candidate => candidate.target.serverIdentityId === selectedTarget.serverIdentityId
            && candidate.target.machineId === selectedTarget.machineId);
        const selectedCandidate = selectedOrigin ? selection.candidates.find((candidate) => exactOriginsEqual(
            selectedOrigin,
            getPluginExecutionOriginCandidateOrigin(candidate),
        )) : null;
        return {
            title: labels.machine,
            titleParts: labels.machineParts,
            subtitle: labels.server,
            detail: selection.state.kind === 'unavailable'
                ? selection.state.reasons.map(originReasonDetail).join(' · ')
                : selectedCandidate
                ? resolveCandidatePresentationDetail(selectedCandidate)
                : t('common.unavailable'),
            selected: true,
            ...(machine?.availability === 'offline' ? { presence: 'offline' as const } : {}),
            automatic: !selection.storedTarget && selection.state.kind === 'selected' && selection.state.selectionSource === 'auto',
            unavailable: selection.state.kind === 'unavailable'
                || !selectedCandidate
                || !isPluginMachineExecutionOriginCandidateSelectable(selectedCandidate),
        };
    }
    if (selection.state.kind === 'conflict') {
        return {
            title: t('common.warning'),
            detail: selection.state.reasons.map(originReasonDetail).join(' · '),
            selected: false,
            unavailable: false,
        };
    }
    // Availability is still being read: nothing is known yet, so say nothing about candidates.
    if (selection.loading) {
        return { title: t('common.loading'), detail: '', selected: false, unavailable: false };
    }
    // Nothing chosen: say so, and whether there is anything to choose from (never the New Session copy).
    return {
        title: selection.state.kind === 'unavailable'
            ? t('settingsPlugins.surfaces.runOnNoneAvailable')
            : t('settingsPlugins.surfaces.runOnNoneChosen'),
        detail: selection.state.kind === 'unavailable'
            ? selection.state.reasons.map(originReasonDetail).join(' · ')
            : t('settingsPlugins.targetSelection.selectionRequired'),
        selected: false,
        unavailable: false,
    };
}

export function PluginMachineExecutionOriginSelectorView(props: Readonly<{
    /** Identifies the page-owned picker; nested unrelated selectors keep local presentation. */
    pluginId?: string;
    selection: PluginMachineExecutionOriginSelectionV1;
    testIDPrefix?: string;
    /** Contextual label for the machine scope this selector presents. */
    groupTitle?: string;
    presentation?: 'section' | 'chip';
    /**
     * A chip in a phone's navigation header, where the page title and the page's own action have the
     * room's priority: it names the Machine like every Machine chip, without the quiet "Auto" word; how
     * it was chosen stays in its accessible hint and in the picker (owner 11-10: the picker keeps its label).
     */
    compact?: boolean;
    machineCandidates?: readonly MachineAdministrationCandidateV1[];
}>) {
    const { theme } = useUnistyles();
    const localPickerState = React.useState(false);
    const pagePickerState = React.useContext(PluginOriginPickerStateContext);
    const pagePicker = pagePickerState?.pluginId === props.pluginId ? pagePickerState : null;
    const [pickerOpen, setPickerOpen] = pagePicker ? pagePicker.state : localPickerState;
    const [settlementError, setSettlementError] = React.useState<string | null>(null);
    const [pendingApproval, setPendingApproval] = React.useState<PluginExecutionOriginPreferenceApproval | null>(null);
    const settleSelection = React.useCallback(async (
        mutation: Promise<PluginExecutionOriginSelectionMutationResult>,
    ) => {
        try {
            const result = await mutation;
            if (result.status === 'approvalPending') {
                setPendingApproval(result);
                setSettlementError(null);
                setPickerOpen(false);
                return true;
            }
            if (result.status === 'applied') {
                setSettlementError(null);
                setPickerOpen(false);
                return true;
            }
            setSettlementError(result.status === 'outcomeUnknown'
                ? t('settingsProviders.errors.mutationOutcomeUnknownDescription')
                : t('settingsPlugins.genericSettingsSaveError'));
        } catch {
            setSettlementError(t('settingsPlugins.genericSettingsSaveError'));
        }
        return false;
    }, []);
    const dismissApproval = React.useCallback(() => setPendingApproval(null), []);
    const finishApproval = React.useCallback((result: PreferenceActionSettlement | null) => {
        setPendingApproval(null);
        if (!result) {
            setSettlementError(t('settingsPlugins.genericSettingsSaveError'));
            return;
        }
        void settleSelection(Promise.resolve(result.status === 'applied' ? { ...result, value: undefined } : result));
    }, [settleSelection]);
    const machineCandidates = props.machineCandidates ?? props.selection.machineCandidates ?? EMPTY_MACHINE_CANDIDATES;
    const current = resolvePluginMachineExecutionOriginPresentation(props.selection, machineCandidates);
    const hasCandidates = props.selection.candidates.length > 0;
    const selectedOrigin = props.selection.selectedOrigin
        ?? (props.selection.state.kind === 'selected' ? props.selection.state.origin : null);
    // Only a pin can be cleared: a Machine Happier picked is not a choice the viewer made.
    const hasChoice = Boolean(props.selection.storedTarget || selectedOrigin) && !current.automatic;
    // A remembered Machine that cannot answer stays the choice: the list marks its row, not a stand-in.
    const storedTarget = props.selection.storedTarget
        ?? (props.selection.state.kind === 'unavailable' ? props.selection.state.storedTarget : null);
    const selectedTarget = storedTarget ?? (selectedOrigin ? { serverIdentityId: selectedOrigin.serverIdentityId,
        machineId: getPluginMachineExecutionOriginRef(selectedOrigin).machineId } : null);
    // Administration owns selected demand independently of this header. Only
    // additional presented rows belong to the open picker.
    const sourceTargets = readPluginPresentedExecutionOriginProjectionTargets(pickerOpen ? props.selection.candidates : [])
        .filter(target => !selectedTarget || target.serverIdentityId !== selectedTarget.serverIdentityId
            || target.machineId !== selectedTarget.machineId);
    const sourceTargetsKey = JSON.stringify(sourceTargets);
    // The canonical selected/presented set, not candidate object identity or
    // ordering, changes this open picker's acquisition question.
    const presentedTargets = React.useMemo(() => sourceTargets,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [sourceTargetsKey]);
    const presentPageTargets = pagePicker?.presentTargets;
    React.useLayoutEffect(() => {
        presentPageTargets?.(presentedTargets);
        // No unmount withdrawal: the page-owned open intent survives header
        // replacement. Closing the picker or retiring the page releases it.
    }, [presentPageTargets, presentedTargets]);
    const projectionDemands = pickerOpen
        ? <PluginPresentedExecutionOriginProjectionDemand key={props.pluginId} targets={presentedTargets} /> : null;
    const isChosenRow = (machine: PresentedPluginOrigin) => selectedOrigin
        ? exactOriginsEqual(selectedOrigin, machine.origin)
        : storedTarget !== null && storedTarget !== undefined
            && machine.serverId === storedTarget.serverIdentityId && machine.id === storedTarget.machineId;
    const currentTestID = props.testIDPrefix ? `${props.testIDPrefix}.current` : undefined;
    const clearTestID = props.testIDPrefix ? `${props.testIDPrefix}.clear` : undefined;
    const groupTitle = props.groupTitle ?? t('settingsProviders.detail.targetMachine');
    const clearAccessibilityScope = props.groupTitle ?? t('settingsPlugins.executionOriginTitle');

    if (props.presentation === 'chip') {
        return <>{projectionDemands}<SelectionListFilterChip filter={{
            id: 'plugin-execution',
            open: pickerOpen,
            onOpenChange: setPickerOpen,
            label: groupTitle,
            valueLabel: props.selection.state.kind === 'unavailable' && !hasChoice ? undefined : current.titleParts?.name ?? current.title,
            ...(current.titleParts?.hint ? { valueQualifier: current.titleParts.hint } : {}),
            // Picked for the viewer: named like a choice, with one quiet word that it was picked, so an
            // explicit pin (no word) and an unavailable pin (the offline dot) each read as themselves.
            ...(current.automatic ? {
                ...(props.compact ? {} : { note: t('settingsPlugins.surfaces.runOnAuto') }),
                accessibilityHint: t('settingsPlugins.surfaces.runOnAutoHint'),
            } : {}),
            icon: <Icon name="desktop" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
            muted: !current.selected,
            // Plugin availability does not establish Machine presence; an unknown Machine keeps no dot.
            ...(current.presence ? { presence: current.presence } : {}),
            ...(current.unavailable ? { accessibilityHint: current.detail } : {}),
            testID: props.testIDPrefix ? `${props.testIDPrefix}.chip` : undefined,
            ...(hasCandidates || hasChoice ? {
                renderPopoverContent: ({ close, maxHeight }) => (
                    <>
                    <PluginOriginPickerGroups candidates={props.selection.candidates} machineCandidates={machineCandidates}>
                    {(groups) => <NewSessionMachineSelectionContent<PresentedPluginOrigin>
                        groups={groups}
                        selectedMachine={groups.flatMap((group) => group.machines).find(isChosenRow) ?? null}
                        selectedServerId={selectedOrigin?.serverIdentityId ?? storedTarget?.serverIdentityId ?? null}
                        recentMachines={[]}
                        favoriteMachines={[]}
                        onSelectMachine={(machine) => { void settleSelection(props.selection.selectOrigin(machine.origin)).then((applied) => { if (applied) close(); }); }}
                        onSelectScopedMachine={(machine) => { void settleSelection(props.selection.selectOrigin(machine.origin)).then((applied) => { if (applied) close(); }); }}
                        resolveMachineAvailability={(machine) => ({
                            detail: resolvePickerRowDetail(machine),
                            selectable: isPluginMachineExecutionOriginCandidateSelectable(machine.candidate),
                        })}
                        resolveMachinePresentation={resolvePickerRowPresentation}
                        showFavorites={false}
                        showRecent={false}
                        showSearch={false}
                        showCliGlyphs={false}
                        autoDetectCliGlyphs={false}
                        testIdPrefix={props.testIDPrefix ? `${props.testIDPrefix}.picker` : undefined}
                        testID={props.testIDPrefix ? `${props.testIDPrefix}.picker-list` : undefined}
                        maxHeight={maxHeight}
                        bodyFooter={hasChoice || settlementError ? <>
                            {hasChoice ? <Item
                                testID={clearTestID}
                                title={t('settingsPlugins.targetSelection.clear')}
                                accessibilityLabel={`${t('settingsPlugins.targetSelection.clear')}: ${clearAccessibilityScope}`}
                                onPress={() => { void settleSelection(props.selection.clearOrigin()).then((applied) => { if (applied) close(); }); }}
                                showChevron={false}
                            /> : null}
                            {settlementError ? <Item title={settlementError} mode="info" showChevron={false} /> : null}
                        </> : null}
                    />}
                    </PluginOriginPickerGroups>
                    </>
                ),
            } : {}),
        }} />{pendingApproval ? <PluginOriginApprovalNotice key={pendingApproval.approval.artifactId} pending={pendingApproval} presentation="inline"
            testID={props.testIDPrefix ? `${props.testIDPrefix}.approvalPending` : undefined}
            onFinished={finishApproval} onScopeChanged={dismissApproval} /> : null}</>;
    }

    return (
        <>
            {projectionDemands}
            <ItemGroup title={groupTitle}>
                {pendingApproval ? <PluginOriginApprovalNotice key={pendingApproval.approval.artifactId} pending={pendingApproval} presentation="row"
                    testID={props.testIDPrefix ? `${props.testIDPrefix}.approvalPending` : undefined}
                    onFinished={finishApproval} onScopeChanged={dismissApproval} /> : null}
                <Item
                    testID={currentTestID}
                    title={current.title}
                    subtitle={[current.subtitle, current.automatic ? `${t('settingsPlugins.surfaces.runOnAutoHint')} · ${current.detail}` : current.detail].filter(Boolean).join('\n')}
                    subtitleLines={0}
                    detail={hasCandidates ? t('common.change') : undefined}
                    selected={current.selected}
                    mode={hasCandidates ? 'interactive' : 'info'}
                    showChevron={hasCandidates}
                    accessibilityExpanded={hasCandidates ? pickerOpen : undefined}
                    accessibilityHint={hasCandidates ? t('common.change') : undefined}
                    onPress={hasCandidates ? () => setPickerOpen((open) => !open) : undefined}
                />
                {hasChoice ? (
                    <Item
                        testID={clearTestID}
                        title={t('settingsPlugins.targetSelection.clear')}
                        accessibilityLabel={`${t('settingsPlugins.targetSelection.clear')}: ${clearAccessibilityScope}`}
                        onPress={() => { void settleSelection(props.selection.clearOrigin()); }}
                        showChevron={false}
                    />
                ) : null}
                {settlementError ? (
                    <Item
                        testID={props.testIDPrefix ? `${props.testIDPrefix}.settlementError` : undefined}
                        title={settlementError}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
            {pickerOpen && hasCandidates ? (
                <PluginOriginPickerGroups candidates={props.selection.candidates} machineCandidates={machineCandidates}>
                {(groups) => <ServerScopedMachineSelector
                    groups={groups}
                    selectedMachineId={selectedOrigin ? getPluginMachineExecutionOriginRef(selectedOrigin).machineId : null}
                    selectedServerId={selectedOrigin?.serverIdentityId ?? null}
                    onSelect={(machine) => { void settleSelection(props.selection.selectOrigin(machine.origin)); }}
                    resolveMachineAvailability={(machine) => ({
                        detail: resolvePickerRowDetail(machine),
                        selectable: isPluginMachineExecutionOriginCandidateSelectable(machine.candidate),
                    })}
                    getMachineKey={(machine) => exactOriginKey(machine.origin)}
                    isMachineSelected={(machine) => exactOriginsEqual(selectedOrigin, machine.origin)}
                    testIdPrefix={props.testIDPrefix}
                />}
                </PluginOriginPickerGroups>
            ) : null}
        </>
    );
}
