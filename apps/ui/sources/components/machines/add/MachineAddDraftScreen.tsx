import * as React from 'react';

import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MACHINES_ADD_SETTINGS } from '@/components/settings/machines/machinesAddSettings';
import { MACHINES_COLLECTION_ROOT } from '@/components/settings/machines/collection/machineCollectionModel';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { MachineAddFormWithFlow } from './MachineAddForm';
import { machineAddLeadsWithCreate, type MachineAddPathId } from './machineAddPaths';
import { readMachineAddDevice } from './useMachineAddPaths';
import { useMachineAddFlow, useMachineAddFlowServerId } from './useMachineAddFlow';
import { useMachineAddFlowDraftSelector } from './machineAddFlowStore';
import { useManagedMachineAccountSettings } from '@/components/settings/machines/managed/useManagedMachineAccountSettings';
import { useManagedControllerScope } from '@/components/settings/machines/managed/useManagedControllerScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

const PATH_IDS: readonly MachineAddPathId[] = ['thisComputer', 'ssh', 'anotherComputer'];

function readPath(value: string | string[] | undefined): MachineAddPathId | undefined {
    const first = Array.isArray(value) ? value[0] : value;
    return PATH_IDS.find((id) => id === first);
}

/**
 * Settings → Machines → the machine being added (lab `add-flows` M4/M5): the collection's draft, titled
 * by its host once typed, with the same form as Home's "Add a machine" block. A machine that joins
 * replaces the draft; Discard stops watching (a machine that joins later still shows up in the list).
 */
export const MachineAddDraftScreen = React.memo(function MachineAddDraftScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ path?: string | string[] }>();
    // The machine joins the Home this device uses (the flow's default target).
    const serverId = useMachineAddFlowServerId();
    const homeName = resolveHomeDisplayName(getServerProfileById(serverId));
    // One read of the Account's opt-out serves the header's promise and the form's Create one.
    const accountScope = useServerCredentialAccountScopeBinding(serverId);
    const accountSettings = useManagedMachineAccountSettings(accountScope.binding, accountScope.resolution);
    const canCreate = accountSettings.settings?.managedMachineCreationEnabled === true;
    // `?path=create` (Home's Machines widget, "Create one in the cloud") opens Create one, as its tab would. Without
    // a path, a phone or a browser opens on it too (58d §D2), unless a setup is already running from this draft.
    const pathParam = Array.isArray(params.path) ? params.path[0] : params.path;
    const initialCreating = pathParam === 'create' ? true
        : pathParam || !machineAddLeadsWithCreate(readMachineAddDevice()) ? false
        : !accountSettings.settings && !accountSettings.error && (accountScope.resolution.kind === 'resolving' || accountScope.resolution.kind === 'bound') ? null
        : canCreate;
    const flow = useMachineAddFlow({ serverId, initialPath: readPath(params.path), initialCreating });
    const draftRow = flow.draftRow;
    // Create one's "Managed from" scope: the form shows its chip beside the ways in while Create one is open,
    // and the catalog below reads the machine it names.
    const creating = useMachineAddFlowDraftSelector((draft) => draft.creating) && canCreate;
    const managedScope = useManagedControllerScope({ serverId, testIDPrefix: 'managed-picker.controller' });
    const navigate = React.useCallback((href: unknown, tag: string, replace: boolean) => {
        const result = runGuardedNavigation(() => (replace ? router.replace(href as never) : router.push(href as never)));
        if (result !== true) fireAndForget(result, { tag });
    }, [router]);
    const leave = React.useCallback(() => navigate(MACHINES_COLLECTION_ROOT, 'MachineAddDraftScreen.leave', true), [navigate]);
    const discard = React.useCallback(async () => {
        if (await flow.discard()) leave();
    }, [flow.discard, leave]);
    const startSession = React.useCallback((machine: Readonly<{ machineId: string; serverId: string }>) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        seedAndOpenNewSession({
            seed: { placement: { kind: 'exactTarget', serverId: machine.serverId, machineId: machine.machineId } },
            scope: lifetime.scope,
            isCurrent: lifetime.isCurrent,
            navigateToNewSession: ({ draftId }) => navigate({
                pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }),
            }, 'MachineAddDraftScreen.startSession', false),
        });
    }, [navigate]);

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <PageHeader
                testID="settings.machines.draft.header"
                alwaysShowTitle={Boolean(draftRow?.entityTitle)}
                title={draftRow?.entityTitle ?? t('settingsOverview.addMachineTitle')}
                description={canCreate ? t('managedMachines.add.pageDescription') : t('addFlows.addMachineDescription')}
                meta={[{ key: 'home', icon: 'house', text: homeName ? t('addFlows.machineJoinsHome', { home: homeName }) : t('managedMachines.add.joinsThisHome') }]}
                actions={(
                    <>
                        <RoundButton
                            testID="settings.machines.draft.discard"
                            size="small"
                            display="inverted"
                            title={t('addFlows.discard')}
                            disabled={flow.approval.approvalPending}
                            onPress={discard}
                        />
                    </>
                )}
            />
            <SettingAnchor setting={MACHINES_ADD_SETTINGS.settings.setupNewMachineAction}>
                    <MachineAddFormWithFlow
                        flow={flow}
                        layout="page"
                        testID="settings.machines.draft.form"
                        initialPath={readPath(params.path)}
                        canCreate={canCreate}
                        managedScope={creating ? managedScope : undefined}
                        onClose={discard}
                        onStartSession={startSession}
                    />
            </SettingAnchor>
        </ItemList>
    );
});
