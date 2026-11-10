import * as React from 'react';
import { Platform } from 'react-native';
import { useNavigation } from 'expo-router';
import { useNewSessionPickerReturnHost } from '@/components/sessions/new/navigation/newSessionEntry';
import { buildNewSessionPickerSubflowHref, completeNewSessionPickerReturn, hasNewSessionPickerContinuation, pickNewSessionRouteParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';

import { useIsFocused, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { useNewSessionEntryRouter as useRouter } from '@/components/sessions/new/navigation/newSessionEntry';
import { MACHINES_ADD_SETTINGS } from '@/components/settings/machines/machinesAddSettings';
import { MACHINES_COLLECTION_ROOT, buildMachineAddHref, type MachineAddRoutePath } from '@/components/settings/machines/collection/machineCollectionModel';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { MachineAddFormWithFlow, machineAddWayTitle, useMachineAddPushesWays } from './MachineAddForm';
import { machineAddLeadsWithCreate, readMachineAddRoutePath } from './machineAddPaths';
import { readMachineAddDevice } from './useMachineAddPaths';
import { useMachineAddFlow, useMachineAddFlowServerId } from './useMachineAddFlow';
import { useManagedMachineAccountSettings } from '@/components/settings/machines/managed/useManagedMachineAccountSettings';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildManagedMachineConfigurationRoute } from '@/components/settings/machines/managed/managedMachineConfigurationRoute';
import { completeMachineAddWatch } from './machineAddTaskLifetime';

/**
 * Settings → Machines → the machine being added (lab `add-flows` M4/M5): the collection's draft, titled
 * "Add a machine" (the typed host names the draft row, never the page; a phone's pushed way takes that way's name), with the same form as Home's "Add a machine" block. A machine that joins
 * replaces the draft; Discard stops watching (a machine that joins later still shows up in the list).
 */
type BeforeRemoveNavigation = Readonly<{
    addListener(type: 'beforeRemove', listener: (event: { preventDefault(): void }) => void): () => void;
}>;

/** While `enabled` on native, the stack's own Back runs `onReturn` once instead of popping; later removals pass. */
export function useNativeBackReturnsToComposer(navigation: BeforeRemoveNavigation, enabled: boolean, onReturn: () => void): void {
    const onReturnRef = React.useRef(onReturn);
    onReturnRef.current = onReturn;
    React.useEffect(() => {
        if (Platform.OS === 'web' || !enabled) return;
        let returned = false;
        return navigation.addListener('beforeRemove', (event) => {
            if (returned) return;
            returned = true;
            event.preventDefault();
            onReturnRef.current();
        });
    }, [navigation, enabled]);
}

export const MachineAddDraftScreen = React.memo(function MachineAddDraftScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const returnToHost = useNewSessionPickerReturnHost();
    const params = useLocalSearchParams<{ path?: string | string[]; serverId?: string | string[]; draftId?: string; newSessionHostDraftId?: string }>();
    const routePath = readMachineAddRoutePath(params.path);
    const requestedServerId = Array.isArray(params.serverId) ? params.serverId[0] : params.serverId;
    const returning = hasNewSessionPickerContinuation(params);
    const focused = useIsFocused();
    const returnToComposer = React.useCallback((machine?: Readonly<{ machineId: string; serverId: string }>) => {
        if (machine) completeMachineAddWatch();
        completeNewSessionPickerReturn({ navigation, router, returnToHost,
            currentParams: pickNewSessionRouteParams(params),
            ...(machine ? { managedMachineSelection: null } : {}),
            routeParams: machine ? { machineId: machine.machineId, spawnServerId: machine.serverId,
                machinePoolId: undefined, directory: undefined, path: undefined } : {},
        });
    }, [navigation, router, returnToHost, params]);
    // Create addresses its own Home; an existing connection task keeps its admitted Home.
    const connectionServerId = useMachineAddFlowServerId();
    const serverId = routePath === 'create' && requestedServerId ? requestedServerId : connectionServerId;
    const separateCreateHome = routePath === 'create' && !areServerProfileIdentifiersEquivalent(serverId, connectionServerId);
    const homeName = resolveHomeDisplayName(getServerProfileById(serverId));
    // One read of the Account's opt-out serves the header's promise and the form's Create one.
    const accountScope = useServerCredentialAccountScopeBinding(serverId);
    const accountSettings = useManagedMachineAccountSettings(accountScope.binding, accountScope.resolution);
    const canCreate = accountSettings.settings?.managedMachineCreationEnabled === true;
    // `?path=create` (Home's Machines widget, "Create one in the cloud") opens Create one, as its tab would. Without
    // a path, a phone or a browser opens on it too (58d §D2), unless a setup is already running from this draft.
    const pathParam = Array.isArray(params.path) ? params.path[0] : params.path;
    const initialPath = routePath === 'create' ? undefined : routePath;
    // A phone's pushed way is titled by it; Back (the settings registry's parent) returns to the ways.
    const pushesWays = useMachineAddPushesWays();
    const pushedWay = pushesWays ? routePath : undefined;
    const initialCreating = pathParam === 'create' ? true
        : pathParam || !machineAddLeadsWithCreate(readMachineAddDevice()) ? false
        : !accountSettings.settings && !accountSettings.error && (accountScope.resolution.kind === 'resolving' || accountScope.resolution.kind === 'bound') ? null
        : canCreate;
    const flow = useMachineAddFlow({ serverId: connectionServerId, initialPath, initialCreating,
        connectionPathVisible: !separateCreateHome && (!pushesWays || Boolean(routePath)) });
    const navigate = React.useCallback((href: unknown, tag: string, replace: boolean) => {
        const result = runGuardedNavigation(() => (replace ? router.replace(href as never) : router.push(href as never)));
        if (result !== true) fireAndForget(result, { tag });
    }, [router]);
    // A phone pushes the chosen way as its own page; that page's `path` says which (58d §D2 phone push).
    const openWay = React.useCallback((way: MachineAddRoutePath) => navigate(returning
        ? buildNewSessionPickerSubflowHref('/settings/machines/add', params, { path: way })
        : buildMachineAddHref({ path: way, serverId: requestedServerId }), 'MachineAddDraftScreen.openWay', false), [navigate, returning, params, requestedServerId]);
    const leave = React.useCallback(() => {
        if (returning) returnToComposer();
        else navigate(MACHINES_COLLECTION_ROOT, 'MachineAddDraftScreen.leave', true);
    }, [navigate, returning, returnToComposer]);
    const discard = React.useCallback(async () => {
        if (separateCreateHome || await flow.discard()) leave();
    }, [flow.discard, leave, separateCreateHome]);
    // Native: the stack's own Back (header, swipe) would pop to the settings page this flow was pushed over. Opened
    // from a composer, Back returns to that composer as Leave does; the return's own removal passes through. A
    // pushed way keeps its Back to the ways, and the web's history already returns to the composer.
    useNativeBackReturnsToComposer(navigation, returning && !pushedWay, returnToComposer);
    const startSession = React.useCallback((machine: Readonly<{ machineId: string; serverId: string }>) => {
        if (returning) { returnToComposer(machine); return; }
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
    }, [navigate, returning, returnToComposer]);

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <PageHeader
                testID="settings.machines.draft.header"
                title={pushedWay ? machineAddWayTitle(pushedWay) : t('settingsOverview.addMachineTitle')}
                description={pushedWay ? undefined : canCreate ? t('managedMachines.add.pageDescription') : t('addFlows.addMachineDescription')}
                meta={[{ key: 'home', icon: 'house', text: homeName ? t('addFlows.machineJoinsHome', { home: homeName }) : t('managedMachines.add.joinsThisHome') }]}
                actions={(
                    <>
                        <RoundButton
                            testID="settings.machines.draft.discard"
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
                        initialPath={initialPath}
                        canCreate={canCreate}
                        creationServerId={serverId}
                        openedWay={routePath}
                        onOpenWay={openWay}
                        onClose={discard}
                        onStartSession={startSession}
                        onArrived={returning && focused && !separateCreateHome ? returnToComposer : undefined}
                        onSelectProvisioner={returning ? selection => navigate(buildNewSessionPickerSubflowHref(
                            buildManagedMachineConfigurationRoute(selection), params,
                        ), 'MachineAddDraftScreen.configure', false) : undefined}
                    />
            </SettingAnchor>
        </ItemList>
    );
});
