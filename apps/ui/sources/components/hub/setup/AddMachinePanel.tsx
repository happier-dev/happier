import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MachineAddForm } from '@/components/machines/add/MachineAddForm';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Home's "Add a machine" grown in place (lab `add-flows` M1–M3, M6): the add-a-machine form itself, in
 * its compact frame. The chosen way runs here — the command, the SSH form, the setup's steps — and the
 * machine arrives in the block; nothing leaves Home until the person starts a session on it.
 */
export const AddMachinePanel = React.memo(function AddMachinePanel(props: Readonly<{
    testIDPrefix: string;
    close: () => void;
}>) {
    const router = useRouter();
    const navigate = React.useCallback((href: unknown, tag: string) => {
        const result = runGuardedNavigation(() => router.push(href as never));
        if (result !== true) fireAndForget(result, { tag });
    }, [router]);
    const startSession = React.useCallback((machine: Readonly<{ machineId: string; serverId: string }>) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        seedAndOpenNewSession({
            seed: { placement: { kind: 'exactTarget', serverId: machine.serverId, machineId: machine.machineId } },
            scope: lifetime.scope,
            isCurrent: lifetime.isCurrent,
            navigateToNewSession: ({ draftId }) => navigate({
                pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }),
            }, 'AddMachinePanel.startSession'),
        });
    }, [navigate]);
    const newPool = React.useCallback(() => navigate('/settings/machines/pools/new', 'AddMachinePanel.newPool'), [navigate]);

    return (
        <MachineAddForm
            layout="panel"
            testID={`${props.testIDPrefix}-panel`}
            onClose={props.close}
            onStartSession={startSession}
            onNewPool={newPool}
        />
    );
});
