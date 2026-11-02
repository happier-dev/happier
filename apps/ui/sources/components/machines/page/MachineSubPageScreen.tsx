import * as React from 'react';
import { RefreshControl } from 'react-native';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

import { Redirect, Stack, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AgentSignInPaneHost } from '@/components/machines/agents/AgentSignInPaneHost';
import { MachineAgentsSection } from '@/components/machines/agents/MachineAgentsSection';
import { MachineDetailsSection } from '@/components/machines/details/MachineDetailsSection';
import { MachineDoctorPageBody } from '@/components/machines/doctorSnapshot/MachineDoctorPageBody';
import { MachineInstallablesSection } from '@/components/machines/installables/MachineInstallablesSection';
import { MachineTerminalPageBody } from '@/components/machines/terminal/MachineTerminalPageBody';
import { MachineComputerUseSection } from '@/components/machines/computer/MachineComputerUseSection';
import { MachineAlertsPage } from '@/components/machines/vitals/MachineAlertsPage';
import { MachineDirectConnectionSection } from '@/components/settings/connections/DirectConnectionSettings';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { MachineSharingSection } from '@/components/sharing/machines/MachineSharingSection';
import { MachineWorkSummaryReader } from '@/components/sharing/machines/MachineWorkSummaryReader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runRefreshDiagnosticAction } from '@/utils/system/userInteractionDiagnostics';

import { MachineTabSubHead } from './MachineTabSubHead';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { useMachinesDoor } from './machinesDoor';
import { isMachineSubPageId, MACHINE_SUB_PAGE_TITLE_KEYS, type MachineSubPageId } from './machineSubPages';
import { useMachinePageTarget, type MachinePageTarget } from './useMachinePageTarget';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

/**
 * A page "This machine" pushes in the detail pane (lab `DD`), in both doors, with the one head every page a machine
 * pushes uses (`MachineTabSubHead`, FA1 #9): the way back named for the machine, the page's name, in the machine
 * page's own wide column. Then the section that owns it, moved here from
 * the machine page, not rewritten. Each keeps the reload it had in the page's refresh.
 */
export function MachineSubPageScreen() {
    const language = usePreferredLanguage();
    const target = useMachinePageTarget();
    const door = useMachinesDoor();
    const router = useRouter();
    const params = useLocalSearchParams<{ page?: string }>();
    const page = params.page;
    const hostedInCollection = useHappierCollectionLayout() !== null;
    // Under a phone's title chrome the head keeps the shorter top inset; its crumb stays (the chrome draws no back of its own here).
    const underChrome = useNavigationTitleChromeShowsTitle();
    const [refreshKey, bumpRefreshKey] = React.useReducer((value: number) => value + 1, 0);
    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const { execute: refreshInventory } = useMountedActionExecution(target.serverId);
    const handleRefresh = React.useCallback(async () => {
        setIsRefreshing(true);
        try {
            await runRefreshDiagnosticAction({ action: 'pull_to_refresh', screen: 'machine_detail' }, async () => {
                bumpRefreshKey();
                const result = await refreshInventory('machines.list', { serverId: target.serverId, refresh: true });
                if (!result.ok) throw new Error(result.error);
            });
        } finally {
            setIsRefreshing(false);
        }
    }, [refreshInventory, target.serverId]);
    const screenOptions = React.useMemo(() => ({
        headerShown: !hostedInCollection,
        headerTitle: '',
        headerBackTitle: target.machine ? target.machineName : t('machine.back'),
    } as const), [language, hostedInCollection, target.machine, target.machineName]);

    const pageHref = target.machineId ? machinePageHref({ door, target: { machineId: target.machineId, serverId: target.serverId || undefined } }) : null;
    const goBack = React.useCallback(() => {
        if (!pageHref) return;
        const result = runGuardedNavigation(() => router.dismissTo(pageHref as never));
        if (result !== true) fireAndForget(result, { tag: 'MachineSubPage.back' });
    }, [pageHref, router]);
    if (!isMachineSubPageId(page)) return pageHref ? <Redirect href={pageHref as never} /> : null;

    const content = (
        <ItemList pageColumn="wide" refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />} keyboardShouldPersistTaps="handled">
            <MachineTabSubHead
                testID={`machine-sub-page-header-${page}`}
                placement="page"
                underNativeChrome={underChrome}
                title={t(MACHINE_SUB_PAGE_TITLE_KEYS[page])}
                back={!pageHref ? null : { label: target.machine ? target.machineName : t('machine.back'), onPress: goBack, testID: `machine-sub-page-back-${page}` }}
                // Sharing's page is its one section (lab m-share A): the head says what it does, the section repeats nothing.
                // Someone the machine is shared with reads what they can do here, not what adding people does.
                description={target.machine && page === 'sharing'
                    ? t(target.machine.isShared ? 'machines.sharing.recipientDescription' : 'machines.sharing.description', { machine: target.machineSentenceName })
                    : target.machine && page === 'computer' ? t('computerUse.providers.pageDescription', { machine: target.machineSentenceName })
                    : null}
            />
            {target.machine ? (
                <MachineSubPageBody page={page} target={target} machine={target.machine} refreshKey={refreshKey} />
            ) : (
                <ItemGroup surface="none">
                    {target.isHydratingMachine
                        ? <SurfaceStateCard testID="machine-detail-loading" kind="loading" title={t('common.loading')} />
                        : <SurfaceStateCard testID="machine-detail-not-found" kind="unavailable" title={t('machine.notFound')} />}
                </ItemGroup>
            )}
        </ItemList>
    );

    return (
        <>
            <Stack.Screen options={screenOptions} />
            {page === 'agents' ? (
                // An agent's own sign-in opens in this page's bottom pane (lab agent-setup T1).
                <AgentSignInPaneHost scopeId={`machine:${target.machineId}`} main={content} />
            ) : content}
        </>
    );
}

function MachineSubPageBody(props: Readonly<{
    page: MachineSubPageId;
    target: MachinePageTarget;
    machine: Machine;
    refreshKey: number;
}>) {
    const { target, machine } = props;
    const serverId = target.serverId;
    const activeAccountScope = useActiveServerAccountScope();
    switch (props.page) {
        case 'sharing':
            return activeAccountScope && areServerProfileIdentifiersEquivalent(activeAccountScope.serverId, serverId) ? (
                <>
                    <MachineSharingSection machineId={machine.id} machineName={target.machineSentenceName} scope={activeAccountScope} online={target.online} />
                    {/* Who else works here is read by the machine for its owner and managers only (D8). */}
                    {!machine.isShared || machine.access?.role === 'manage' ? (
                        <MachineWorkSummaryReader machineId={machine.id} machineName={target.machineSentenceName} scope={activeAccountScope}
                            online={target.online} refreshKey={props.refreshKey} />
                    ) : null}
                </>
            ) : null;
        case 'agents':
            // The page's header is already "Agents": the section does not repeat it.
            return <MachineAgentsSection serverId={serverId} machineId={machine.id} machineName={target.machineSentenceName} titled={false} />;
        case 'terminal':
            return <MachineTerminalPageBody machine={machine} serverId={serverId} isServerSwitching={target.isServerSwitching} refreshKey={props.refreshKey} />;
        case 'computer':
            return <MachineComputerUseSection serverId={serverId} machineId={machine.id} machineName={target.machineSentenceName} online={target.online === true} />;
        case 'connection':
            return <MachineDirectConnectionSection serverId={serverId} machineId={machine.id} machineName={target.machineSentenceName} />;
        case 'installables':
            return <MachineInstallablesSection machineId={machine.id} serverId={serverId} />;
        case 'doctor':
            return <MachineDoctorPageBody machine={machine} serverId={serverId} switchReady={target.switchReady} refreshKey={props.refreshKey} />;
        case 'details':
            return <MachineDetailsSection machine={machine} serverId={serverId} />;
        case 'alerts':
            return <MachineAlertsPage serverId={serverId} machine={machine} machineName={target.machineSentenceName} />;
    }
}

