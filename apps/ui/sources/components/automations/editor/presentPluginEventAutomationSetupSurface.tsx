import * as React from 'react';
import { View } from 'react-native';
import { PluginModalCardFooterSlot, PluginModalCardFooterSlotContext, usePluginModalCardFooterSlot } from '@/components/plugins/surfaces/pluginModalCardFooterSlot';

import {
    PluginUiEphemeralInputSettlementV1Schema,
    PluginUiJsonValueV1Schema,
    type PluginUiEphemeralInputSettlementV1,
} from '@happier-dev/protocol/plugins/ui';
import type { DaemonContributionRegistryProjectionAutomationEligibleEventV1, DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiLaunchInputV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiActionFailureV1 } from '@happier-dev/protocol/plugins/ui/client';
import { WorkflowValidationIssueV1Schema } from '@happier-dev/protocol/workflows/workflowValidationIssueV1';
import { HappierValidationMessage } from '@happier-dev/plugin-ui/presentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    PluginSurfaceHost,
    type PluginSurfaceEphemeralMountProps,
} from '@/components/plugins/surfaces/PluginSurfaceHost';
import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiHandlers,
} from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { readPluginSurfaceEphemeralMountBinding } from '@/components/plugins/surfaces/pluginSurfaceMountBinding';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { useUnistyles } from 'react-native-unistyles';
import { useMachineListForServer, useServerScopedMachineLabel } from '@/sync/store/hooks';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { PluginMachineExecutionOriginPickerProvider } from '@/components/settings/machines/PluginMachineExecutionOriginSelector';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal';
import type { BaseModalConfig } from '@/modal/types';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    getMachineContributionRegistryProjectionAuthorityRevision,
    subscribeMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjection';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

export type NativeSetupWatcherChoice = Readonly<{ machineId: string; selected: boolean }>;

export type NativeSetupWatcherSelection = Readonly<{
    getSnapshot: () => readonly NativeSetupWatcherChoice[];
    subscribe: (listener: () => void) => () => void;
    canChoose: (machineId: string) => boolean;
}>;

type SetupSurfaceWatcherSelection = Readonly<{
    watcherSelection?: NativeSetupWatcherSelection;
}>;

const noWatcherChoices = () => undefined;
const subscribeToNoWatcherChoices = () => () => {};

/** A refused write handed back to the open draft: the owner's typed failure and its presented sentence, unchanged. */
export type PluginEventAutomationSetupSurfaceRefusal = Readonly<{
    failure: PluginUiActionFailureV1;
    reason: string;
    /** Where the host leads when the remedy is elsewhere ("Edit the saved source…"), shown at "Check from". */
    remedy?: SetupIssueRemedy;
}>;

export type SetupIssueRemedy = Readonly<{ label: string; onPress: () => void }>;
type SetupOriginIssueState = Readonly<{ message: string; remedy?: SetupIssueRemedy }>;

/**
 * The open setup sheet after its form completed: the draft stays mounted, its Save busy, until the write settles.
 * `close` ends it (the write landed or nothing remains to show); `refuse` gives the draft back with the refusal at
 * its fields; `next` waits for the draft's next Save, Cancel or Machine change.
 */
export type PluginEventAutomationSetupSurfaceHold = Readonly<{
    close: () => void;
    refuse: (refusal: PluginEventAutomationSetupSurfaceRefusal) => boolean;
    next: (signal?: AbortSignal) => Promise<PluginEventAutomationSetupSurfaceSettlement>;
}>;

export type PluginEventAutomationSetupSurfaceSettlement = PluginUiEphemeralInputSettlementV1
    | Readonly<{ kind: 'completed'; input: Extract<PluginUiEphemeralInputSettlementV1, { kind: 'completed' }>['input'];
        hold: PluginEventAutomationSetupSurfaceHold }>
    | Readonly<{ kind: 'superseded'; machineId: string; draft: unknown }>;

/** A held settlement's reply to the form: null once the write landed, a host error while the draft takes it back. */
type SetupSurfaceSettleReply = Promise<PluginUiJsonValueV1 | null> | null;

// The trigger write's issue paths, by the sheet region that answers them: the plugin's form owns the source, the host
// owns where it is checked from (workflowTriggerAccountHost's source-consistency refusal).
const SOURCE_ISSUE_PATH = '/trigger/sourceConfig';
const ORIGIN_ISSUE_PATH = '/trigger/observationTransport';

function readWriteIssues(details: unknown) {
    const issues = details !== null && typeof details === 'object' ? Reflect.get(details, 'issues') : undefined;
    return Array.isArray(issues) ? issues.flatMap((issue) => {
        const parsed = WorkflowValidationIssueV1Schema.safeParse(issue);
        return parsed.success && parsed.data.severity === 'error' ? [parsed.data] : [];
    }) : [];
}

function messagesAt(issues: readonly { path: string; message: string }[], path: string) {
    const messages = issues.filter(issue => issue.path === path || issue.path.startsWith(`${path}/`)).map(issue => issue.message);
    return messages.length > 0 ? messages.join(' ') : undefined;
}

export function createPluginEventAutomationSetupSurfaceBinding(params: Readonly<{
    isSettled: () => boolean;
    settle: (settlement: PluginUiEphemeralInputSettlementV1) => SetupSurfaceSettleReply | void;
}>): BoundPluginSurfaceBinding {
    return Object.freeze({
        createMountedHostApiHandlers: ({ isCurrent }) => {
            const handlers: PluginSurfaceHostApiHandlers = Object.freeze({
                settleEphemeralInput: (request) => {
                    if (!isCurrent() || params.isSettled()) {
                        return createPluginSurfaceHostApiError('stale_surface', [
                            'ephemeral_input_mount_retired',
                        ]);
                    }
                    const parsed = PluginUiEphemeralInputSettlementV1Schema.safeParse(request.payload);
                    if (!parsed.success) {
                        return createPluginSurfaceHostApiError('invalid_payload', [
                            'ephemeral_input_settlement_invalid',
                        ]);
                    }
                    return params.settle(parsed.data) ?? null;
                },
            });
            return Object.freeze({ handlers });
        },
    });
}

/**
 * `setup`: an Automation's event setup page, which draws no title of its own: the card's band carries the
 * event title and its description at every width. `picker`: an Action form's input picker, which continues
 * the form it opens from; its page draws its own title on a wide screen, so the card draws no second band
 * there (the title stays the dialog's accessible name; Cancel and Esc close it). A phone sheet keeps its band.
 */
export type PluginEphemeralInputSurfacePresentation = 'setup' | 'picker';

export function resolvePluginEphemeralInputSurfaceChrome(input: Readonly<{
    title: string;
    description?: string;
    presentation: PluginEphemeralInputSurfacePresentation;
    phone: boolean;
    footer: React.ReactNode;
}>) {
    return {
        ...createAnchoredSheetChrome({
            title: input.title,
            ...(input.presentation === 'setup' && input.description ? { subtitle: input.description } : {}),
        }),
        header: input.presentation === 'picker' && !input.phone ? 'none' as const : 'band' as const,
        // A setup form is content, not a scroller: the card's body scrolls it under the footer that holds its actions
        // (PAGE-ACCEPT-176 R12-D1). A picker's rows own their scrolling, so its body stays a bounded viewport.
        ...(input.presentation === 'setup' ? { bodyScroll: 'auto' as const } : {}),
        footer: input.footer,
    };
}

// Keeps the body's height contract (it fills and may shrink) while adding the card's content edge.
const SETUP_SURFACE_INSET = { flexGrow: 1, flexShrink: 1, minHeight: 0, paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx } as const;

type SetupSurfaceModalProps = Readonly<{
    surface: DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1;
    title: string;
    description?: string;
    /** The host's name for the Machine this setup runs on ("Check from"), shown as the sheet's first field. */
    originLabel?: string;
    presentation: PluginEphemeralInputSurfacePresentation;
    launchInput?: PluginUiLaunchInputV1;
    projection: DaemonMergedProjectionInputs;
    machineId: string;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    /** A held settlement returns the form's reply; any other closes the sheet. */
    onSettle: (settlement: PluginUiEphemeralInputSettlementV1) => SetupSurfaceSettleReply;
    /** The refused write's issue at "Check from", while the draft holds it. */
    originIssue?: SetupSurfaceIssueStore;
    watcherSelection?: NativeSetupWatcherSelection;
    chooseWatcher?: (machineId: string, draft: unknown) => boolean;
}> & CustomModalInjectedProps;

type SetupSurfaceIssueStore = Readonly<{ get: () => SetupOriginIssueState | undefined; subscribe: (listener: () => void) => () => void }>;
const noIssue = () => undefined;

function PluginEventAutomationSetupSurfaceModal(
    props: SetupSurfaceModalProps,
): React.ReactElement | null {
    const setupSurface = props.surface;
    const mount = React.useMemo(
        () => setupSurface ? readPluginSurfaceEphemeralMountBinding(setupSurface) : null,
        [setupSurface],
    );
    const settledRef = React.useRef(false);
    const onSettleRef = React.useRef(props.onSettle);
    onSettleRef.current = props.onSettle;
    const onCloseRef = React.useRef(props.onClose);
    onCloseRef.current = props.onClose;
    const settle = React.useCallback((settlement: PluginUiEphemeralInputSettlementV1) => {
        if (settledRef.current) return null;
        // A held Save keeps the sheet: its owner closes it once the write lands, or hands the draft back.
        const held = onSettleRef.current(settlement);
        if (held) return held;
        settledRef.current = true;
        onCloseRef.current();
        return null;
    }, []);
    const binding = React.useMemo<BoundPluginSurfaceBinding>(() => (
        createPluginEventAutomationSetupSurfaceBinding({
            isSettled: () => settledRef.current,
            settle,
        })
    ), [settle]);
    // A form that offers its own footer (its Cancel and primary together) takes the card's footer, pinned beside the
    // card's edge; until then, and for forms without one, the card keeps its Cancel (PAGE-ACCEPT-176 R11-D1).
    const footerSlot = usePluginModalCardFooterSlot();
    const hasDraft = React.useSyncExternalStore(footerSlot.subscribe, footerSlot.hasDraft, footerSlot.hasDraft);
    const readWatchers = props.watcherSelection?.getSnapshot ?? noWatcherChoices;
    const watcherChoices = React.useSyncExternalStore(
        props.watcherSelection?.subscribe ?? subscribeToNoWatcherChoices, readWatchers, readWatchers);
    const readOriginIssue = props.originIssue?.get ?? noIssue;
    const originIssue = React.useSyncExternalStore(
        props.originIssue?.subscribe ?? subscribeToNoWatcherChoices, readOriginIssue, readOriginIssue);
    const chooseWatcher = (machineId: string) => {
        if (settledRef.current) return false;
        const draft = footerSlot.captureDraft();
        if (draft === undefined || !props.chooseWatcher?.(machineId, draft)) return false;
        settledRef.current = true;
        return true;
    };
    const footer = React.useMemo(() => (
        <PluginModalCardFooterSlot store={footerSlot} fallback={
            <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'flex-end' }}>
                <RoundButton
                    testID="plugin-event-automation-setup-surface-cancel"
                    accessibilityLabel={t('common.cancel')}
                    title={t('common.cancel')}
                    size="normal"
                    display="inverted"
                    onPress={() => settle({ kind: 'cancelled' })}
                />
            </View>
        } />
    ), [footerSlot, settle]);
    const phone = useDeviceType() === 'phone';
    const chrome = React.useMemo(() => resolvePluginEphemeralInputSurfaceChrome({
        title: props.title, description: props.description, presentation: props.presentation, phone, footer,
    }), [footer, phone, props.description, props.presentation, props.title]);
    useModalCardChrome(props.setChrome, chrome);

    React.useEffect(() => () => {
        if (!settledRef.current) onSettleRef.current({ kind: 'cancelled' });
    }, []);

    if (!mount || !setupSurface) return null;
    const actionInputSelectionFactsKey = props.projection.ephemeralInputSurfaceActionInputSelectionFacts.get(setupSurface);
    if (!actionInputSelectionFactsKey) throw new Error('ephemeral_input_surface_action_input_selection_facts_missing');
    const ephemeralMount: PluginSurfaceEphemeralMountProps = Object.freeze({
        mount,
        boundaryResetKey: [
            setupSurface.contribution.pluginId,
            setupSurface.contribution.localId,
            setupSurface.occurrenceId,
            setupSurface.projectionGeneration,
        ].join(':'),
        physicalTarget: Object.freeze({ kind: 'app' as const }),
        parentLifetime: props.accountLifetime,
        pluginProjectionById: props.projection.pluginProjectionById,
        pluginProjectionV2: props.projection.pluginProjectionV2,
        pluginUiProjection: props.projection.pluginUiProjection,
        actionInputSelectionFactsKey,
        binding,
    });
    const host = <PluginSurfaceHost ephemeralMount={ephemeralMount} machineId={props.machineId} serverId={props.serverId}
        launchInput={props.launchInput} />;
    const origin = props.originLabel ? <SetupOriginRow label={props.originLabel} machineId={props.machineId}
        serverId={props.serverId} watcherChoices={hasDraft ? watcherChoices : undefined}
        chooseWatcher={chooseWatcher} {...(originIssue ? { issue: originIssue.message,
            ...(originIssue.remedy ? { issueRemedy: originIssue.remedy } : {}) } : {})} /> : null;
    // The picker owns its plugin's Run-on picker, so an offline Machine's "Choose another" opens it here.
    return (
        <PluginModalCardFooterSlotContext.Provider value={footerSlot.set}>
        <PluginMachineExecutionOriginPickerProvider pluginId={setupSurface.contribution.pluginId}>
            {/* A setup form stands on the card's content edge, in line with its title and footer; a picker's rows run to
                the card edge themselves (ROWS-FLEET-OPS-177 F4: the health setup form sat flush against the card). */}
            {props.presentation === 'setup' ? <View style={SETUP_SURFACE_INSET}>{origin}{host}</View> : host}
        </PluginMachineExecutionOriginPickerProvider>
        </PluginModalCardFooterSlotContext.Provider>
    );
}

/** The shared field issue line, in the plugin forms' theme, so "Check from" says its remedy as the fields below do. */
function SetupOriginIssue(props: Readonly<{ message: string; remedy?: SetupIssueRemedy }>) {
    const { theme } = useUnistyles();
    const line = <HappierValidationMessage testID="plugin-event-automation-setup-surface-origin-issue"
        message={props.message} theme={usePluginUiTheme(theme)} accessibilityLiveRegion="polite" />;
    if (!props.remedy) return line;
    // A remedy that lives elsewhere leads there, under the sentence that names it.
    return <View style={{ alignItems: 'flex-start', gap: theme.space.s4 }}>
        {line}
        <TextLinkButton testID="plugin-event-automation-setup-surface-origin-remedy" label={props.remedy.label}
            onPress={props.remedy.onPress} />
    </View>;
}

/** Where the setup runs, as the sheet's first field (the composer preselects the surface's Machine). */
export function SetupOriginRow(props: Readonly<{
    label: string;
    machineId: string;
    serverId: string | null;
    watcherChoices?: readonly NativeSetupWatcherChoice[];
    chooseWatcher: (machineId: string) => boolean;
    /** A refused write's remedy for where the check runs, shown at this field as the form's own fields show theirs. */
    issue?: string;
    /** Leads to that remedy when it lives elsewhere. */
    issueRemedy?: SetupIssueRemedy;
}>) {
    const { theme } = useUnistyles();
    const issue = props.issue ? <SetupOriginIssue message={props.issue} {...(props.issueRemedy ? { remedy: props.issueRemedy } : {})} /> : null;
    const machine = useServerScopedMachineLabel(props.serverId, props.machineId);
    const all = useMachineListForServer(props.serverId);
    // The composer's usable watchers (21fe08b30ac): choosing another moves the open form there with what was typed.
    const choices = props.watcherChoices;
    const machines = React.useMemo(() => !choices || choices.length < 2 ? null
        : (all ?? []).filter(candidate => choices.some(choice => choice.machineId === candidate.id)), [all, choices]);
    if (machines && machines.length > 1 && props.serverId) {
        const selected = choices?.find(choice => choice.selected)?.machineId ?? props.machineId;
        // The field's row bleeds to the form's edge, so its label stands where the plugin's labels below it do
        // (R13-D8: as a bare row it sat one row inset further in, x 470 against the tiles' 456).
        return <ListPresentationProvider value="page" pageInsets="contained"><ItemGroup surface="none" header="none">
            <SessionMachineField testID="plugin-event-automation-setup-surface-origin" serverId={props.serverId}
                machines={machines} machineId={selected} title={props.label}
                onSelectMachine={next => { if (next.id !== selected) props.chooseWatcher(next.id); }} />
        </ItemGroup>{issue ? <View style={{ paddingBottom: theme.space.s16 }}>{issue}</View> : null}</ListPresentationProvider>;
    }
    // It stands on the form's own edge and rhythm, as the plugin's fields below it do: a label over its value.
    return (
        <View testID="plugin-event-automation-setup-surface-origin" style={{ gap: theme.space.s4, paddingBottom: theme.space.s16 }}>
            <Text variant="body" emphasis="medium" style={{ color: theme.colors.text.primary }}>{props.label}</Text>
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{machine ?? t('machine.unnamedMachine')}</Text>
            {issue}
        </View>
    );
}

/**
 * Mount one exact cold-projected setup surface and return its first terminal
 * input settlement. This function owns no durable state and performs no Action
 * invocation; its caller revalidates and submits the value through the generic
 * Action input owner.
 */
type EphemeralInputSurfaceParams = Readonly<{
    surface: DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1;
    title: string;
    description?: string;
    originLabel?: string;
    presentation: PluginEphemeralInputSurfacePresentation;
    launchInput?: PluginUiLaunchInputV1;
    projection: DaemonMergedProjectionInputs;
    machineId: string;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
    commandBridge?: BaseModalConfig['commandBridge'];
    /** Keep a completed form open with its Save busy until the caller settles its hold (setup sheets only). */
    holdUntilSettled?: true;
}>;

export function presentPluginEphemeralInputSurface(params: EphemeralInputSurfaceParams & { watcherSelection?: never }):
    Promise<PluginUiEphemeralInputSettlementV1>;
export function presentPluginEphemeralInputSurface(params: EphemeralInputSurfaceParams & SetupSurfaceWatcherSelection):
    Promise<PluginEventAutomationSetupSurfaceSettlement>;
export async function presentPluginEphemeralInputSurface(params: EphemeralInputSurfaceParams & SetupSurfaceWatcherSelection):
    Promise<PluginEventAutomationSetupSurfaceSettlement> {
    const setupSurface = params.surface;
    const plugin = params.projection.pluginProjectionById[
        setupSurface.contribution.pluginId
    ];
    if (
        !setupSurface
        || !readPluginSurfaceEphemeralMountBinding(setupSurface)
        || setupSurface.selectedRenderer.availability.state !== 'available'
        || plugin?.enabled !== true
        || params.projection.pluginProjectionV2?.generation !== setupSurface.projectionGeneration
        || params.signal?.aborted
        || !params.accountLifetime.isCurrent()
    ) return { kind: 'cancelled' };

    return await new Promise<PluginEventAutomationSetupSurfaceSettlement>((resolve) => {
        let modalId = '';
        // open: the draft takes input; held: its Save waits on the write; done: the sheet is gone.
        let phase: 'open' | 'held' | 'done' = 'open';
        let waiter: ((settlement: PluginEventAutomationSetupSurfaceSettlement) => void) | null = resolve;
        let pending: PluginEventAutomationSetupSurfaceSettlement | null = null;
        let heldReply: ((reply: PluginUiJsonValueV1 | null) => void) | null = null;
        let presentationSignal: AbortSignal | undefined;
        let originIssue: SetupOriginIssueState | undefined;
        const originIssueListeners = new Set<() => void>();
        const setOriginIssue = (next: SetupOriginIssueState | undefined) => {
            if (next === originIssue) return;
            originIssue = next;
            originIssueListeners.forEach(listener => listener());
        };
        let releaseRetirement: (() => void) | undefined;
        let releaseProjection: (() => void) | undefined;
        const deliver = (settlement: PluginEventAutomationSetupSurfaceSettlement) => {
            const current = waiter;
            waiter = null;
            if (current) current(settlement);
            else pending = settlement;
        };
        const detachSignal = () => {
            presentationSignal?.removeEventListener('abort', onAbort);
            presentationSignal = undefined;
        };
        const attachSignal = (signal: AbortSignal | undefined) => {
            detachSignal();
            if (!signal) return;
            if (signal.aborted) { onAbort(); return; }
            presentationSignal = signal;
            signal.addEventListener('abort', onAbort, { once: true });
        };
        const finish = (settlement: PluginEventAutomationSetupSurfaceSettlement, reply: PluginUiJsonValueV1 | null =
            createPluginSurfaceHostApiError('stale_surface', ['ephemeral_input_mount_retired'])) => {
            if (phase === 'done') return;
            phase = 'done';
            detachSignal();
            releaseRetirement?.();
            releaseProjection?.();
            const replyToForm = heldReply;
            heldReply = null;
            replyToForm?.(reply);
            if (modalId) Modal.hide(modalId);
            deliver(settlement);
        };
        function onAbort() { finish({ kind: 'cancelled' }); }
        const hold: PluginEventAutomationSetupSurfaceHold = Object.freeze({
            close: () => finish({ kind: 'cancelled' }, null),
            refuse: (refusal: PluginEventAutomationSetupSurfaceRefusal) => {
                if (phase !== 'held' || !heldReply) return false;
                const issues = readWriteIssues(refusal.failure.details);
                const atOrigin = messagesAt(issues, ORIGIN_ISSUE_PATH);
                // The form says the source's own remedy, or the typed reason; "Check from" says its own when it is shown.
                const message = [messagesAt(issues, SOURCE_ISSUE_PATH) ?? refusal.reason,
                    ...(params.originLabel ? [] : [atOrigin])].filter(Boolean).join(' ');
                const details = PluginUiJsonValueV1Schema.safeParse(refusal.failure.details);
                phase = 'open';
                setOriginIssue(params.originLabel && atOrigin
                    ? { message: atOrigin, ...(refusal.remedy ? { remedy: refusal.remedy } : {}) } : undefined);
                const replyToForm = heldReply;
                heldReply = null;
                replyToForm(createPluginSurfaceHostApiError(refusal.failure.errorCode, [], message, {
                    ...(details.success ? { details: details.data } : {}),
                    ...(refusal.failure.requestId ? { requestId: refusal.failure.requestId } : {}),
                    ...(refusal.failure.retryable === undefined ? {} : { retryable: refusal.failure.retryable }),
                }));
                return true;
            },
            next: (signal?: AbortSignal) => {
                const ready = pending;
                pending = null;
                if (ready) return Promise.resolve(ready);
                if (phase === 'done') return Promise.resolve({ kind: 'cancelled' } as const);
                attachSignal(signal);
                return new Promise<PluginEventAutomationSetupSurfaceSettlement>(next => { waiter = next; });
            },
        });
        const onSurfaceSettle = (settlement: PluginUiEphemeralInputSettlementV1): SetupSurfaceSettleReply => {
            if (phase === 'held') {
                return Promise.resolve(createPluginSurfaceHostApiError('stale_surface', ['ephemeral_input_write_pending']));
            }
            if (phase === 'open' && params.holdUntilSettled && settlement.kind === 'completed') {
                // The write now owns the sheet's lifetime; the setup's own operation ending no longer closes it.
                phase = 'held';
                detachSignal();
                setOriginIssue(undefined);
                return new Promise(reply => {
                    heldReply = reply;
                    deliver({ kind: 'completed', input: settlement.input, hold });
                });
            }
            finish(settlement);
            return null;
        };
        attachSignal(params.signal);
        const retirement = params.accountLifetime.onRetire(onAbort);
        releaseRetirement = () => retirement.dispose();
        const projectionScope = {
            machineId: params.machineId, serverId: params.serverId,
        };
        const authorityRevision = getMachineContributionRegistryProjectionAuthorityRevision(projectionScope);
        releaseProjection = subscribeMachineContributionRegistryProjectionInvalidation(projectionScope, () => {
            // A refresh of the same watcher must let a refused write return to the open draft.
            if (!params.holdUntilSettled || getMachineContributionRegistryProjectionAuthorityRevision(projectionScope) !== authorityRevision) {
                onAbort();
            }
        });
        if (phase === 'done') {
            releaseRetirement();
            releaseProjection();
            return;
        }
        modalId = Modal.show({
            component: PluginEventAutomationSetupSurfaceModal,
            commandBridge: params.commandBridge,
            props: {
                surface: params.surface,
                title: params.title,
                description: params.description,
                ...(params.originLabel ? { originLabel: params.originLabel } : {}),
                presentation: params.presentation,
                launchInput: params.launchInput,
                projection: params.projection,
                machineId: params.machineId,
                serverId: params.serverId,
                accountLifetime: params.accountLifetime,
                onSettle: onSurfaceSettle,
                ...(params.holdUntilSettled ? { originIssue: { get: () => originIssue, subscribe: (listener: () => void) => {
                    originIssueListeners.add(listener);
                    return () => { originIssueListeners.delete(listener); };
                } } } : {}),
                watcherSelection: params.watcherSelection,
                chooseWatcher: (machineId: string, draft: unknown) => {
                    if (phase !== 'open' || !params.watcherSelection?.canChoose(machineId) || !PluginUiJsonValueV1Schema.safeParse(draft).success) return false;
                    finish({ kind: 'superseded', machineId, draft });
                    return true;
                },
            },
            onRequestClose: onAbort,
            onHostUnmount: onAbort,
            closeOnBackdrop: false,
        });
        if (!modalId || params.signal?.aborted || !params.accountLifetime.isCurrent()) onAbort();
    });
}

export type SetupSurfaceHeading = Readonly<{ title: string; description?: string; originLabel?: string }>;

export function presentPluginEventAutomationSetupSurface(params: Readonly<{
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    projection: DaemonMergedProjectionInputs;
    machineId: string;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
    commandBridge?: BaseModalConfig['commandBridge'];
    launchInput?: PluginUiLaunchInputV1;
    /** The host's own name for this setup (Add check), in place of the Event's trigger wording, and for its Machine. */
    heading?: SetupSurfaceHeading;
}> & SetupSurfaceWatcherSelection): Promise<PluginEventAutomationSetupSurfaceSettlement> {
    const surface = params.eligibleEvent.setupSurface;
    if (!surface) return Promise.resolve({ kind: 'cancelled' });
    const { heading, ...rest } = params;
    return presentPluginEphemeralInputSurface({
        ...rest, surface, title: heading?.title ?? params.eligibleEvent.event.title,
        description: heading ? heading.description : params.eligibleEvent.event.description ?? undefined,
        ...(heading?.originLabel ? { originLabel: heading.originLabel } : {}),
        presentation: 'setup',
        holdUntilSettled: true,
    });
}
