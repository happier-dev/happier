import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import * as React from 'react';
import { shallow } from 'zustand/shallow';
import { hasOpenedManagedMachinePresetCreationV1, isOpenedManagedMachinePresetV1, type OpenedManagedMachinePresetCreationV1, type OpenedManagedMachinePresetV1, type ManagedMachinePresetListEntryV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { MACHINE_PRESET_TEAM_KEY_PENDING } from '@/sync/domains/machines/presets/machinePresetReadFailure';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { getStorage, useMachineDisplayNamesById } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveManagedWakeAvailability } from '@/sync/domains/pending/managedWakeProjection';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { useManagedMachineAccountSettings } from '@/components/settings/machines/managed/useManagedMachineAccountSettings';
import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { MANAGED_PROVISIONER_MARK_SIZE, ManagedPresetCost, ManagedPresetMark, ManagedPresetOfferLine } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { describeManagedPresetOffer } from '@/components/settings/machines/managed/managedConfigurationPresentation';
import { describeManagedPresetKeyPending } from '@/components/settings/machines/managed/managedNativeFailurePresentation';
import { MachineProvisionerPicker, type ManagedProvisionerSelection } from '@/components/settings/machines/managed/MachineProvisionerPicker';
import { ManagedMachineConfigurationView } from '@/components/settings/machines/managed/ManagedMachineConfigurationView';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { t } from '@/text';
import { buildManagedMachineSelectionOffers, type ManagedMachineDestinationProjection, type ManagedMachineSelectionOffer, type ManagedMachineUse } from './managedMachineSelection';

/** A Project may hand off its exact controller/config selectors; ordinary pickers supply none. */
export type ManagedMachineConfigurationContinuation = ManagedProvisionerSelection & Readonly<{
    optionsSelectors?: Readonly<Record<string, unknown>>;
}>;
type OffersProps = Readonly<{
    serverId: string;
    initialConfiguration?: ManagedMachineConfigurationContinuation;
    onOffers: (serverId: string, offers: readonly ManagedMachineSelectionOffer[], projection: ManagedMachineDestinationProjection) => void;
    onUse: ManagedMachineUse;
    /**
     * Called as the configurator opens. A popover host closes itself here: the configurator is its
     * own modal and outlives the picker that opened it (lab m-pick: the configurator stands alone).
     */
    onConfigure?: () => void;
    /** The composer holds a drafted prompt: the receipt creates the machine and starts the session with it. */
    startsSession?: () => boolean;
}>;

/**
 * Opens the "New machine" configurator for a preset or a one-off. The modal owns its own lifetime:
 * it closes on use, on its own close button, or when the Account binding retires, never because the
 * picker that opened it went away, so the host can close first and the configurator then stands alone.
 */
export function useManagedMachineConfigurator(input: Readonly<{
    serverId: string;
    binding: ServerCredentialAccountScopeBinding | null;
    initialConfiguration?: ManagedMachineConfigurationContinuation;
    onUse: ManagedMachineUse;
    onConfigure?: () => void;
    startsSession?: () => boolean;
}>): (preset: (OpenedManagedMachinePresetV1 & OpenedManagedMachinePresetCreationV1) | null) => void {
    const { binding, serverId, initialConfiguration } = input;
    // Host handlers are per render; only the Account binding and target identify the configurator.
    const onUse = useEventCallback(input.onUse);
    const onConfigure = useEventCallback(() => input.onConfigure?.());
    const startsSession = useEventCallback(() => input.startsSession?.());
    return React.useCallback((preset: (OpenedManagedMachinePresetV1 & OpenedManagedMachinePresetCreationV1) | null) => {
        if (!binding?.isCurrent() || preset && !hasOpenedManagedMachinePresetCreationV1(preset)) return;
        onConfigure();
        // The opener's binding belongs to the picker and dies with it; the modal keeps its own (below),
        // for the same Account.
        // Whether a prompt is drafted is read once, as it opens: the modal never subscribes to the composer's text.
        Modal.show({ component: ManagedMachineSelectionConfigurationModal,
            props: { serverId, preset, initialConfiguration, accountId: binding.accountId, onUse, startsSession: startsSession() === true } });
    }, [binding, serverId, initialConfiguration, onUse, onConfigure, startsSession]);
}

/** Mounted only by an open creation-capable picker; Account opt-out precedes every preset read. */
export function ManagedMachineSelectionOffers(props: OffersProps) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(props.serverId);
    const account = useManagedMachineAccountSettings(binding, resolution);
    React.useEffect(() => {
        if (account.settings?.managedMachineCreationEnabled !== true) props.onOffers(props.serverId, [], {
            state: account.settings?.managedMachineCreationEnabled === false ? 'unavailable' : 'pending', rowCount: 0 });
    }, [account.settings, props.serverId, props.onOffers]);
    if (!binding?.isCurrent() || account.settings?.managedMachineCreationEnabled !== true) return null;
    return <CurrentManagedMachineSelectionOffers {...props} binding={binding} key={JSON.stringify([props.serverId, binding.accountId, binding.revision])} />;
}

/** The picker's one-tap offers, built from presets and the machine names their controllers show. */
export function useManagedMachineSelectionOffers(input: Readonly<{
    homeId: string | null | undefined;
    binding: ServerCredentialAccountScopeBinding | null;
    serverId: string;
    presets: readonly ManagedMachinePresetListEntryV1[] | undefined;
    configure: (preset: (OpenedManagedMachinePresetV1 & OpenedManagedMachinePresetCreationV1) | null) => void;
}>): readonly ManagedMachineSelectionOffer[] {
    const { homeId, binding, serverId, presets, configure } = input;
    const controllerIds = React.useMemo(() => presets?.flatMap(preset => preset.controller ? [preset.controller.machineId] : []) ?? [], [presets]);
    const names = useMachineDisplayNamesById(controllerIds, { serverId });
    const store = getStorage();
    const readControllers = React.useCallback(() => {
        const state = store.getState();
        return controllerIds.map(id => resolveServerScopedMachine(state, serverId, id));
    }, [store, serverId, controllerIds]);
    const readUnavailable = React.useCallback((nowMs: number) => {
        const controllers = new Map(readControllers().flatMap(controller => controller ? [[controller.id, controller] as const] : []));
        const unavailable: Record<string, true> = {};
        const scope = binding?.isCurrent() ? binding.scope : null;
        for (const preset of presets ?? []) {
            // Pools choose their controller at configuration; Account-side creation has no assigned controller.
            if (!preset.controller) continue;
            const controller = controllers.get(preset.controller.machineId);
            const availability = resolveManagedWakeAvailability(preset.controller, controller
                ? { ...controller, online: describeMachinePresenceLine(controller, nowMs, undefined, scope).online } : undefined);
            if (availability.kind === 'unavailable') unavailable[preset.id] = true;
        }
        return unavailable;
    }, [binding, presets, readControllers]);
    const presenceTargets = React.useMemo(() => [{ serverId, machineIds: controllerIds }], [serverId, controllerIds]);
    const unavailable = useMachinePresenceSnapshot(readControllers, readUnavailable, presenceTargets, shallow);
    return React.useMemo(() => homeId && binding?.isCurrent() ? buildManagedMachineSelectionOffers({
        homeId, presets: presets ?? [],
        oneOffTitle: t('managedMachines.picker.oneOff'), oneOffSubtitle: t('managedMachines.picker.oneOffHelp'),
        describeOffer: preset => describeManagedPresetOffer(preset),
        describeUnavailable: preset => !unavailable[preset.id] ? undefined
            : preset.controller && names[preset.controller.machineId]
                ? t('managedMachines.controller.required', { controller: names[preset.controller.machineId]! })
                : t('managedMachines.controller.requiredUnnamed'),
        markFor: preset => <ManagedPresetMark serverId={serverId} accountScope={binding.scope} preset={preset} size={MANAGED_PROVISIONER_MARK_SIZE.rail} />,
        // A local machine runs on the machine that manages it; a pool-backed preset names none (the pool picks one).
        lineFor: (preset, extra) => <ManagedPresetOfferLine serverId={serverId} accountScope={binding.scope} preset={preset} extra={extra} />,
        costFor: preset => <ManagedPresetCost serverId={serverId} accountScope={binding.scope} preset={preset}
            runsOn={preset.controllerPoolId || !preset.controller ? undefined : names[preset.controller.machineId] ?? preset.controller.machineId} />,
        onConfigure: configure,
    }) : [], [homeId, binding, presets, serverId, names, unavailable, configure]);
}

function CurrentManagedMachineSelectionOffers(props: OffersProps & Readonly<{ binding: ServerCredentialAccountScopeBinding }>) {
    const { binding } = props;
    const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
    const scopeKey = JSON.stringify([props.serverId, binding?.accountId, binding?.revision]);
    const approval = useActionApprovalContinuation({ serverId: props.serverId, scopeKey, onExecuted: () => {} });
    const presets = useMachinePresets(serverIds, approval.requestApproval);
    const state = presets.statesByServerId[props.serverId];
    const waitingForPresetKey = React.useMemo(() => state?.value?.some(preset => preset.archivedAt === undefined
        && !isOpenedManagedMachinePresetV1(preset) && preset.reason === MACHINE_PRESET_TEAM_KEY_PENDING), [state?.value]);
    const keyPending = waitingForPresetKey ? describeManagedPresetKeyPending(MACHINE_PRESET_TEAM_KEY_PENDING) : null;
    const homeId = getServerProfileById(props.serverId)?.serverIdentityId;
    const router = useRouter();
    const configure = useManagedMachineConfigurator({ serverId: props.serverId, binding,
        initialConfiguration: props.initialConfiguration, onUse: props.onUse, onConfigure: props.onConfigure, startsSession: props.startsSession });
    const offers = useManagedMachineSelectionOffers({ homeId, binding, serverId: props.serverId,
        presets: presets.presetsByServerId[props.serverId], configure });
    React.useEffect(() => { props.onOffers(props.serverId, offers, {
        state: !binding?.isCurrent() || state?.loading !== false || !!state?.error ? 'pending' : 'available', rowCount: offers.length,
    }); }, [offers, binding, state?.loading, state?.error, props.serverId, props.onOffers]);
    return <>
        {approval.approvalId ? <AttentionBanner testID="managed-machine-selection-approval" title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(buildApprovalHref(approval.approvalId!, props.serverId) as never) }} /> : null}
        {state?.error ? <SurfaceStateCard kind="error" title={t('machinePresets.loadFailed')} diagnosticCode={state.error}
            action={{ label: t('common.retry'), onPress: presets.refresh }} /> : null}
        {keyPending ? <SurfaceStateCard kind="unavailable" size="line" lineLayout="notice" {...keyPending} /> : null}
    </>;
}

function ManagedMachineSelectionConfigurationModal(props: CustomModalInjectedProps & Readonly<{
    serverId: string; preset: (OpenedManagedMachinePresetV1 & OpenedManagedMachinePresetCreationV1) | null; initialConfiguration?: ManagedMachineConfigurationContinuation;
    accountId: string;
    onUse: ManagedMachineUse;
    startsSession: boolean;
}>) {
    // The modal holds its own Account binding (the picker that opened it may be gone): it closes once
    // the Home is bound to a different Account, and only uses a draft while the opening Account is
    // the current one. A profile refresh that rebinds the same Account leaves it open.
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const closeRef = React.useRef(props.onClose);
    closeRef.current = props.onClose;
    const otherAccount = binding !== null && binding.accountId !== props.accountId;
    React.useEffect(() => {
        if (otherAccount) closeRef.current();
    }, [otherAccount]);
    // Options (`{ send: true }`) pass through unchanged to the composer's one Send.
    const use: ManagedMachineUse = (draft, options) => {
        if (!binding?.isCurrent() || binding.accountId !== props.accountId) return;
        props.onClose();
        props.onUse(draft, options);
    };
    const [selected, setSelected] = React.useState<ManagedProvisionerSelection | null>(() => props.preset ? {
        serverId: props.serverId, provisioner: buildQualifiedPluginContributionKey(props.preset.launch.provider), controller: props.preset.controller,
    } : props.initialConfiguration?.serverId === props.serverId ? props.initialConfiguration : null);
    React.useEffect(() => { props.setChrome?.({ kind: 'card', title: t('managedMachines.picker.newMachine'),
        dimensions: { size: 'lg' }, phonePresentation: 'sheet', bodyScroll: 'auto', closeButtonTestID: 'managed-selection.back' }); }, [props.setChrome]);
    return selected ? <ManagedMachineConfigurationView serverId={selected.serverId} provisioner={selected.provisioner}
        initialController={selected.controller} presetId={props.preset?.id}
        initialConnectPurpose={selected.connectPurpose}
        initialOptionsSelectors={!props.preset && selected === props.initialConfiguration ? props.initialConfiguration?.optionsSelectors : undefined}
        onUse={use} startsSession={props.startsSession} />
        : <MachineProvisionerPicker serverId={props.serverId} onSelectProvisioner={setSelected} />;
}
