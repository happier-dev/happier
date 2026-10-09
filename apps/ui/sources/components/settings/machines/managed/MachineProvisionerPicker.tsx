import * as React from 'react';
import { View } from 'react-native';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';
import { useManagedProvisioners } from './useManagedProvisioners';
import { useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { MachineProvisionerSections } from './MachineProvisionerSections';
import type { ManagedProvisionerCard } from './managedMachineDisplay';

export type ManagedProvisionerSelection = Readonly<{ serverId: string; provisioner: string; controller: ManagedControllerV1 }>;
type MachineProvisionerPickerProps = Readonly<{
    serverId: string; presetOnly?: boolean;
    /** Local presentation handoff to the same configurator, without navigation or acquisition. */
    onSelectProvisioner?: (selection: ManagedProvisionerSelection) => void;
}>;

export function MachineProvisionerPicker(props: MachineProvisionerPickerProps) {
    useServerProfilesGeneration();
    const [selectedHome, setSelectedHome] = React.useState(props.serverId);
    if (!selectedHome) return <View testID="managed-picker"><ItemGroup title={t('managedMachines.receipt.joins')}>
        {listServerProfiles().map(home => <Item key={home.id} testID={`managed-picker.home:${home.id}`} title={home.name} onPress={() => setSelectedHome(home.id)} />)}
    </ItemGroup></View>;
    return <MachineProvisionerCatalog key={selectedHome} serverId={selectedHome} presetOnly={props.presetOnly} onSelectProvisioner={props.onSelectProvisioner} />;
}

function MachineProvisionerCatalog(props: MachineProvisionerPickerProps) {
    const handler = React.useRef<(registration: ActionApprovalRegistration) => void>(() => {});
    const onApprovalPending = React.useCallback((registration: ActionApprovalRegistration) => handler.current(registration), []);
    const [controller, setController] = React.useState<ManagedControllerV1 | undefined>();
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, controller);
    const approval = useActionApprovalContinuation({ serverId: props.serverId, scopeKey: JSON.stringify([props.serverId, catalog.binding?.accountId]), onExecuted: () => {} });
    handler.current = approval.requestApproval;
    const router = useRouter();
    const machines = useMachineListForServer(props.serverId) ?? [];
    const [checks, setChecks] = React.useState<Readonly<Record<string, MachineProvisionerCheckResultV1>>>({});
    const [error, setError] = React.useState<string | null>(null);
    const compact = useViewportClass() === 'compact';
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller });
    const { localized, markFor } = presentation;
    const repairAbort = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => repairAbort.current?.abort(), [catalog.binding, controller]);
    React.useEffect(() => {
        const binding = catalog.binding;
        if (!binding || !catalog.homeId || !catalog.client || !controller) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => { abort.abort(); setChecks({}); setController(undefined); });
        setChecks({});
        void Promise.all(catalog.provisioners.map(async provisioner => ({
            id: buildQualifiedPluginContributionKey(provisioner.contribution),
            result: await catalog.client!.read('machines.provisioners.check', { homeId: catalog.homeId!, controller, contribution: provisioner.contribution }, { signal: abort.signal, onApprovalPending }),
        }))).then(results => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            setChecks(Object.fromEntries(results.flatMap(({ id, result }) => result.kind === 'succeeded' ? [[id, result.value]] : [])));
            setError(results.find(({ result }) => result.kind === 'failed')?.result.kind === 'failed' ? 'unavailable' : null);
        }).catch(() => { if (!abort.signal.aborted && binding.isCurrent()) setError('unavailable'); });
        return () => { abort.abort(); retirement.dispose(); };
    }, [catalog.binding, catalog.homeId, catalog.client, catalog.provisioners, controller, onApprovalPending]);
    const open = (contribution: string) => {
        if (props.onSelectProvisioner) {
            if (controller && catalog.binding?.isCurrent()) props.onSelectProvisioner({ serverId: props.serverId, provisioner: contribution, controller });
            return;
        }
        const params = new URLSearchParams({ serverId: props.serverId });
        if (props.presetOnly) params.set('presetOnly', 'true');
        if (controller) { params.set('machineId', controller.machineId); params.set('installationId', controller.installationId); }
        router.push(`/settings/machines/add/${encodeURIComponent(contribution)}?${params.toString()}` as never);
    };
    const cards: ManagedProvisionerCard[] = catalog.provisioners.flatMap(provisioner => {
        const location = provisioner.descriptor.billing.location;
        if (location !== 'local' && location !== 'cloud') return [];
        const id = buildQualifiedPluginContributionKey(provisioner.contribution);
        const check = checks[id];
        const repairAction = check?.prerequisites?.find(prerequisite => prerequisite.status !== 'available' && prerequisite.repairAction)?.repairAction;
        return [{ id, title: localized(provisioner.contribution.pluginId, provisioner.descriptor.title), kind: provisioner.descriptor.resourceKind,
            description: location === 'local' ? t('managedMachines.add.localDescriptionShort', { computer: getMachineDisplayName(machines.find(machine => machine.id === controller?.machineId)) ?? controller?.machineId ?? '' })
                : t('managedMachines.add.cloudDescriptionShort'), location, mark: markFor(provisioner),
            status: { tone: check ? check.available ? 'ready' : 'attention' : 'none', label: check ? t(check.available ? 'managedMachines.add.status.ready' : 'managedMachines.add.status.needsSetup') : t('managedMachines.providers.loading') },
            action: repairAction ? { kind: 'repair', label: t('managedMachines.add.action.setUp'), onPress: () => {
                const binding = catalog.binding;
                if (!binding?.isCurrent()) return;
                repairAbort.current?.abort();
                const abort = new AbortController(); repairAbort.current = abort;
                void presentation.repair(repairAction, binding, abort.signal).then(outcome => {
                    if (abort.signal.aborted || !binding.isCurrent()) return;
                    if (outcome.ok) catalog.refresh(); else setError(outcome.reason);
                }).catch(() => { if (!abort.signal.aborted && binding.isCurrent()) setError('unavailable'); });
            } } : { kind: 'choose', label: t('managedMachines.add.action.choose'), onPress: () => open(id) } }];
    });
    return <View testID="managed-picker">
        {approval.approvalId ? <AttentionBanner title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        {catalog.loading ? <SurfaceStateCard kind="loading" title={t('managedMachines.providers.loading')} /> : null}
        {catalog.error || error ? <SurfaceStateCard testID="managed-picker.unavailable" kind="error" title={t('managedMachines.providers.unavailable')} diagnosticCode={catalog.error ?? error ?? undefined}
            action={{ label: t('common.retry'), onPress: catalog.refresh }} /> : null}
        {controller && !catalog.loading && !catalog.error && catalog.provisioners.length === 0 ? <SurfaceStateCard kind="empty" title={t('managedMachines.providers.empty')} /> : null}
        <ItemGroup title={t('managedMachines.config.managedFrom')}>
            {machines.filter(machine => !!machine.installationId).map(machine => <Item key={machine.id} title={getMachineDisplayName(machine) ?? machine.id}
                testID={`managed-picker.controller:${machine.id}`} selected={controller?.machineId === machine.id}
                onPress={() => { if (machine.installationId) setController({ machineId: machine.id, installationId: machine.installationId }); }} />)}
        </ItemGroup>
        {controller ? <MachineProvisionerSections cards={cards} compact={compact} testID="managed-picker.provisioners"
            localTitle={t('managedMachines.add.onThisComputer')} localDescription={t('managedMachines.add.localDescriptionShort', { computer: getMachineDisplayName(machines.find(machine => machine.id === controller.machineId)) ?? controller.machineId })} /> : null}
        {controller ? <ItemGroup surface="none">{catalog.provisioners.filter(provisioner => provisioner.descriptor.billing.location === 'unknown').map(provisioner => {
            const id = buildQualifiedPluginContributionKey(provisioner.contribution);
            return <Item key={id} title={localized(provisioner.contribution.pluginId, provisioner.descriptor.title)} icon={markFor(provisioner)} onPress={() => open(id)} />;
        })}</ItemGroup> : null}
    </View>;
}
