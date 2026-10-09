import * as React from 'react';

import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MACHINES_ADD_SETTINGS } from '@/components/settings/machines/machinesAddSettings';
import { MACHINES_COLLECTION_ROOT } from '@/components/settings/machines/collection/machineCollectionModel';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { MachineAddForm } from './MachineAddForm';
import type { MachineAddPathId } from './machineAddPaths';
import { discardMachineAdd, useMachineAddDraftRow } from './useMachineAddFlow';

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
    const draftRow = useMachineAddDraftRow();
    // The machine joins the Home this device uses (the flow's default target).
    const activeServer = useActiveServerSnapshot();
    const homeName = resolveHomeDisplayName(getServerProfileById(activeServer.serverId)) ?? t('settingsAccount.thisHomeTitle');
    const navigate = React.useCallback((href: unknown, tag: string, replace: boolean) => {
        const result = runGuardedNavigation(() => (replace ? router.replace(href as never) : router.push(href as never)));
        if (result !== true) fireAndForget(result, { tag });
    }, [router]);
    const leave = React.useCallback(() => navigate(MACHINES_COLLECTION_ROOT, 'MachineAddDraftScreen.leave', true), [navigate]);
    const discard = React.useCallback(() => {
        discardMachineAdd();
        leave();
    }, [leave]);
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
                title={draftRow?.title ?? t('machineAdd.newMachine')}
                description={t('addFlows.addMachineDescription')}
                meta={[{ key: 'home', icon: 'house', text: t('addFlows.machineJoinsHome', { home: homeName }) }]}
                actions={(
                    <RoundButton
                        testID="settings.machines.draft.discard"
                        size="small"
                        display="inverted"
                        title={t('addFlows.discard')}
                        onPress={discard}
                    />
                )}
            />
            <ItemGroup surface="none">
                <SettingAnchor setting={MACHINES_ADD_SETTINGS.settings.setupNewMachineAction}>
                    <MachineAddForm
                        layout="page"
                        testID="settings.machines.draft.form"
                        initialPath={readPath(params.path)}
                        onClose={discard}
                        onStartSession={startSession}
                    />
                </SettingAnchor>
            </ItemGroup>
        </ItemList>
    );
});
