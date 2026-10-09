import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { ManagedReceiptPageLayout } from './ManagedReceiptPageLayout';
import { ManagedMachineSections, useManagedMachineHeaderIdentity } from './ManagedMachineSections';
import { useManagedMachineInventory } from './useManagedMachineInventory';
import { ManagedMachineReadApprovalNotice } from './ManagedMachineReadApprovalNotice';

const execute = createFrontDoorActionExecute();
type ManagedMachineDetailProps = Readonly<{ managedId: string; serverId: string;
    executeAction?: ReturnType<typeof createFrontDoorActionExecute> }>;
function parameter(value: string | string[] | undefined): string {
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export function ManagedMachineDetailScreen() {
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[] }>();
    return <ManagedMachineDetail managedId={parameter(params.id)} serverId={parameter(params.serverId)} />;
}

/** The saved managed destination resolves the server row, then uses the existing enrolled Machine page. */
export function ManagedMachineDetail(props: ManagedMachineDetailProps) {
    return <ManagedMachineDetailBody key={JSON.stringify([props.serverId, props.managedId])} {...props} />;
}

function ManagedMachineDetailBody(props: ManagedMachineDetailProps) {
    const { theme } = useUnistyles();
    const layout = useHappierCollectionLayout();
    const serverId = resolveServerProfileScopeIdForIdentifier(props.serverId) || props.serverId;
    const serverIds = React.useMemo(() => serverId && props.managedId ? [serverId] : [], [serverId, props.managedId]);
    const executeAction = props.executeAction ?? execute;
    const inventory = useManagedMachineInventory(serverIds, props.managedId || undefined, executeAction);
    const entry = inventory.entries[serverId];
    const accountState = inventory.accountScopes.get(serverId);
    const [actionError, setActionError] = React.useState<string | null>(null);
    const machine = entry?.machines[0];
    const identity = useManagedMachineHeaderIdentity(entry?.status === 'denied' ? undefined : machine, serverId);
    const profile = getServerProfileById(serverId);
    const homeName = resolveHomeDisplayLabel(profile, serverId);
    const forbidden = entry?.status === 'denied' || actionError === 'permission_denied'
        || actionError === 'not_authenticated' || actionError === 'action_account_scope_changed';
    const enrolledMachineId = forbidden ? undefined : machine?.enrolledMachineId;
    if (enrolledMachineId) return <Redirect href={{ pathname: '/machine/[id]',
        params: { id: enrolledMachineId, serverId: props.serverId } }} />;

    const mark = (machine && !forbidden ? identity?.mark : undefined) ?? <Icon name="desktop" color={theme.colors.text.secondary} />;

    const showMachine = Boolean(machine && !forbidden);
    const loading = inventory.loading && !machine;
    const reason = forbidden || accountState?.resolution.kind === 'signed_out'
        ? t('managedMachines.detail.readRefused') : entry?.status === 'missing'
            ? t('managedMachines.detail.missing') : t('managedMachines.detail.loadFailed');
    return <ManagedReceiptPageLayout testID="managed-machine.detail" compact={layout?.mode !== 'split'}
        header={{ title: showMachine ? machine!.launch.name : t('settings.machines'), leading: mark,
            description: (showMachine ? identity?.description : null) ?? t('managedMachines.detail.creationDescription'),
            meta: [{ key: 'home', text: homeName }, ...(showMachine ? identity?.meta ?? [] : [])],
            actions: <RoundButton size="small" display="secondary" title={t('common.retry')}
                onPress={() => { setActionError(null); inventory.refresh(); }} testID="managed-machine.refresh" /> }}
        /* The sections own the receipt beside them, with Stop and Delete at its foot. */
        receipt={null}>
        <ManagedMachineReadApprovalNotice serverId={serverId} entry={entry} />
        {!showMachine ? <SurfaceStateCard testID="managed-machine.read-state" kind={loading ? 'loading' : forbidden ? 'denied' : 'unavailable'}
            title={loading ? t('common.loading') : reason} diagnosticCode={entry?.errorCode}
            action={loading ? undefined : { label: t('common.retry'), onPress: inventory.refresh }} /> : <>
            {entry?.status === 'loading' || entry?.status === 'error' || entry?.status === 'unsupported' ? <SurfaceFreshnessLine testID="managed-machine.freshness"
                asOf={entry.asOf} reason={entry.status === 'loading' ? t('common.loading') : t('managedMachines.detail.loadFailed')}
                busy={entry.status === 'loading'} action={{ label: t('common.retry'), onPress: inventory.refresh }} /> : null}
            <ManagedMachineSections machine={machine!} serverId={serverId} executeAction={executeAction}
                binding={inventory.bindings.get(serverId)} current={entry?.status === 'ready'}
                onChanged={inventory.refresh} onDenied={setActionError} />
            {actionError ? <SurfaceStateCard kind="error" size="line" title={t('managedMachines.detail.loadFailed')}
                diagnosticCode={actionError} testID="managed-machine.action-error" /> : null}
        </>}
    </ManagedReceiptPageLayout>;
}
