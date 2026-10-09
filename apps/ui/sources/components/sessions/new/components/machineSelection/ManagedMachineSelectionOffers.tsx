import * as React from 'react';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useManagedMachineAccountSettings } from '@/components/settings/machines/managed/useManagedMachineAccountSettings';
import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { MachineProvisionerPicker, type ManagedProvisionerSelection } from '@/components/settings/machines/managed/MachineProvisionerPicker';
import { ManagedMachineConfigurationView } from '@/components/settings/machines/managed/ManagedMachineConfigurationView';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { t } from '@/text';
import { buildManagedMachineSelectionOffers, type ManagedMachineDestinationProjection, type ManagedMachineSelectionDraft, type ManagedMachineSelectionOffer } from './managedMachineSelection';

type OffersProps = Readonly<{
    serverId: string;
    onOffers: (serverId: string, offers: readonly ManagedMachineSelectionOffer[], projection: ManagedMachineDestinationProjection) => void;
    onUse: (draft: ManagedMachineSelectionDraft) => void;
}>;

/** Mounted only by an open Session picker; Account opt-out precedes every preset read. */
export function ManagedMachineSelectionOffers(props: OffersProps) {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const account = useManagedMachineAccountSettings(binding ?? undefined);
    React.useEffect(() => {
        if (account.settings?.managedMachineCreationEnabled !== true) props.onOffers(props.serverId, [], {
            state: account.settings?.managedMachineCreationEnabled === false ? 'unavailable' : 'pending', rowCount: 0 });
    }, [account.settings, props.serverId, props.onOffers]);
    if (!binding?.isCurrent() || account.settings?.managedMachineCreationEnabled !== true) return null;
    return <CurrentManagedMachineSelectionOffers {...props} binding={binding} key={JSON.stringify([props.serverId, binding.accountId, binding.revision])} />;
}

function CurrentManagedMachineSelectionOffers(props: OffersProps & Readonly<{ binding: ServerCredentialAccountScopeBinding }>) {
    const { binding } = props;
    const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
    const scopeKey = JSON.stringify([props.serverId, binding?.accountId, binding?.revision]);
    const approval = useActionApprovalContinuation({ serverId: props.serverId, scopeKey, onExecuted: () => {} });
    const presets = useMachinePresets(serverIds, approval.requestApproval);
    const state = presets.statesByServerId[props.serverId];
    const homeId = getServerProfileById(props.serverId)?.serverIdentityId;
    const machines = useMachineListForServer(props.serverId);
    const router = useRouter();
    const modalId = React.useRef<string | null>(null);
    const configure = React.useCallback((preset: ManagedMachinePresetV1 | null) => {
        if (!binding?.isCurrent()) return;
        if (modalId.current) Modal.hide(modalId.current);
        modalId.current = Modal.show({ component: ManagedMachineSelectionConfigurationModal,
            props: { serverId: props.serverId, preset, onUse: draft => {
                if (binding.isCurrent()) props.onUse(draft);
            } } });
    }, [binding, props.serverId, props.onUse]);
    React.useEffect(() => {
        const close = () => { if (modalId.current) Modal.hide(modalId.current); modalId.current = null; };
        const retirement = binding?.onRetire(close);
        return () => { close(); retirement?.dispose(); };
    }, [binding]);
    const offers = React.useMemo(() => homeId && binding?.isCurrent() ? buildManagedMachineSelectionOffers({
        homeId, presets: presets.presetsByServerId[props.serverId] ?? [],
        oneOffTitle: t('managedMachines.picker.oneOff'), oneOffSubtitle: t('managedMachines.picker.oneOffHelp'),
        describeController: preset => getMachineDisplayName(machines?.find(machine => machine.id === preset.controller.machineId)) ?? preset.controller.machineId,
        onConfigure: configure,
    }) : [], [homeId, binding, presets.presetsByServerId, props.serverId, machines, configure]);
    React.useEffect(() => { props.onOffers(props.serverId, offers, {
        state: !binding?.isCurrent() || state?.loading !== false || !!state?.error ? 'pending' : 'available', rowCount: offers.length,
    }); }, [offers, binding, state?.loading, state?.error, props.serverId, props.onOffers]);
    return <>
        {approval.approvalId ? <AttentionBanner title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        {state?.error ? <SurfaceStateCard kind="error" title={t('machinePresets.loadFailed')} diagnosticCode={state.error}
            action={{ label: t('common.retry'), onPress: presets.refresh }} /> : null}
    </>;
}

function ManagedMachineSelectionConfigurationModal(props: CustomModalInjectedProps & Readonly<{
    serverId: string; preset: ManagedMachinePresetV1 | null; onUse: (draft: ManagedMachineSelectionDraft) => void;
}>) {
    const [selected, setSelected] = React.useState<ManagedProvisionerSelection | null>(() => props.preset ? {
        serverId: props.serverId, provisioner: buildQualifiedPluginContributionKey(props.preset.recipe.provider), controller: props.preset.controller,
    } : null);
    React.useEffect(() => { props.setChrome?.({ kind: 'card', title: t('managedMachines.picker.newMachine'),
        dimensions: { size: 'lg' }, phonePresentation: 'sheet', bodyScroll: 'auto', closeButtonTestID: 'managed-selection.back' }); }, [props.setChrome]);
    return selected ? <ManagedMachineConfigurationView serverId={selected.serverId} provisioner={selected.provisioner}
        initialController={selected.controller} presetId={props.preset?.id}
        onUse={draft => { props.onClose(); props.onUse(draft); }} />
        : <MachineProvisionerPicker serverId={props.serverId} onSelectProvisioner={setSelected} />;
}
