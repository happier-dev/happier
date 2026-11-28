import * as React from 'react';
import { arePluginMachineExecutionOriginsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import { buildV2PluginProjectionById } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { resolveCurrentContributedAction } from '@/components/appShell/currentUiContext/contributedActionInvocation';
import { readCurrentAppShellPluginUiProjection, subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { openPluginContributedAction } from '@/components/plugins/actions/openPluginContributedAction';
import { comparePluginContributedActionDescriptors, createPluginContributedActionController,
    type PluginContributedActionCurrentSnapshot, type PluginContributedActionForm } from '@/components/plugins/actions/pluginContributedActionController';
import { usePluginUiClientExecutableRegistrationRevision } from '@/components/plugins/reactNative/clientExecutableContributions';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { useSessionMachineControlTarget } from '@/components/sessions/model/useSessionMachineTarget';
import type { DropdownMenuItem, DropdownMenuSelection } from '@/components/ui/forms/dropdown/DropdownMenu';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { createPluginUiProjectedActionResolver, isPluginProjectedActionExecutable } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiProjectionEntryExecutionOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';

const EMPTY_ITEMS: readonly DropdownMenuItem[] = Object.freeze([]);

/** A row borrows the existing projection/controller only while its menu or selected form needs it. */
export function useSessionRowPluginActions(params: Readonly<{
    serverId: string | null;
    sessionId: string;
    open: boolean;
}>) {
    const [actionDemand, setActionDemand] = React.useState(false);
    const demanded = params.open || actionDemand;
    const serverId = params.serverId;
    const sessionId = params.sessionId;
    const machine = useSessionMachineControlTarget(demanded && serverId ? sessionId : '', serverId);
    const machineId = demanded ? machine?.machineId ?? null : null;
    const bindings = useServerCredentialAccountScopeBindings(demanded && serverId ? [serverId] : []);
    const accountLifetime = bindings.values().next().value ?? null;
    const readAdmittedProjection = React.useCallback(() => demanded && accountLifetime?.isCurrent()
        ? readCurrentAppShellPluginUiProjection({ scope: accountLifetime.scope, declarationsOnly: true }) : null,
    [accountLifetime, demanded]);
    const subscribeAdmission = React.useCallback((listener: () => void) => demanded
        ? subscribeCommittedAppShellPluginUiProjection(listener) : () => {}, [demanded]);
    const admittedProjection = React.useSyncExternalStore(subscribeAdmission, readAdmittedProjection, readAdmittedProjection);
    const pluginProjectionById = React.useMemo(() => admittedProjection
        ? buildV2PluginProjectionById({ generation: admittedProjection.generation,
            installedPackagesById: admittedProjection.installedPackagesById,
            actionsById: admittedProjection.actionsById, resourcesById: admittedProjection.resourcesById }) : null,
    [admittedProjection]);
    const localize = usePluginLocalizedTextResolver({ projection: admittedProjection });
    // A closed row menu presents no Action, so an index commit redraws no row.
    const clientRevision = usePluginUiClientExecutableRegistrationRevision(undefined, demanded);
    const navigation = usePluginSurfaceDestinationNavigationBinding();
    const contextReader = useOptionalCurrentUiContextReader();
    const snapshotRef = React.useRef<PluginContributedActionCurrentSnapshot | null>(null);
    const scope = React.useMemo(() => new AbortController(), [accountLifetime, machineId, serverId, sessionId]);
    const formRef = React.useRef<PluginContributedActionForm | null>(null);
    const unsubscribeForm = React.useRef<(() => void) | null>(null);
    React.useEffect(() => {
        setActionDemand(false);
        return () => {
            scope.abort();
            unsubscribeForm.current?.();
            unsubscribeForm.current = null;
            formRef.current?.retire();
            formRef.current = null;
        };
    }, [scope]);

    snapshotRef.current = admittedProjection && pluginProjectionById && serverId && accountLifetime ? {
        pluginProjectionById,
        pluginUiProjection: admittedProjection,
        localize,
        resolveContributedAction: createPluginUiProjectedActionResolver(admittedProjection.actionsById),
        host: { serverId, sessionId, sessionRow: true, machineId, accountLifetime, signal: scope.signal,
            ...(navigation ? { openSurface: navigation.openSurface } : {}),
            ...(contextReader ? { readCurrentUiContext: contextReader.readCurrentUiContext } : {}),
            isCurrent: () => !scope.signal.aborted && accountLifetime.isCurrent()
                && snapshotRef.current?.host.signal === scope.signal
                && (readMachineControlTargetForSession({ serverId, sessionId })?.machineId ?? null) === machineId,
            isActionCurrent: identity => {
                const admitted = resolveCurrentContributedAction(readAdmittedProjection, identity);
                const raw = createPluginUiProjectedActionResolver(admittedProjection.actionsById)(identity);
                if (!admitted || !raw || admitted.action.occurrenceId !== raw.occurrenceId
                    || !isPluginProjectedActionExecutable(admitted.action)
                    || !areServerProfileIdentifiersEquivalent(admitted.origin.serverId, accountLifetime.scope.serverId)) return false;
                if (admitted.kind === 'account') return admitted.origin.accountId === accountLifetime.scope.accountId;
                const rawOrigin = readPluginUiProjectionEntryExecutionOrigin(raw);
                return admitted.origin.machineId === machineId && !!admitted.origin.executionOrigin && !!rawOrigin
                    && arePluginMachineExecutionOriginsEqual(admitted.origin.executionOrigin, rawOrigin);
            },
        },
    } : null;
    const controller = React.useMemo(() => createPluginContributedActionController({
        resolveCurrent: () => snapshotRef.current?.host.signal === scope.signal && !scope.signal.aborted
            ? snapshotRef.current : null,
    }), [clientRevision, scope]);
    const actions = React.useMemo(() => {
        if (!params.open || !admittedProjection) return [];
        const unique = new Map([...controller.list({ placement: 'rowAction', scope: 'session' }),
            ...controller.list({ placement: 'contextMenu', scope: 'session' })]
            .map(action => [action.qualifiedActionId, action]));
        return [...unique.values()].sort(comparePluginContributedActionDescriptors);
    }, [admittedProjection, controller, localize, params.open]);
    const items = React.useMemo((): readonly DropdownMenuItem[] => actions.length ? actions.map(action => ({
        id: action.qualifiedActionId, title: action.title,
        ...(action.description ? { subtitle: action.description } : {}),
    })) : EMPTY_ITEMS, [actions]);
    const select = React.useCallback(async (itemId: string, selection?: DropdownMenuSelection): Promise<boolean> => {
        const action = actions.find(candidate => candidate.qualifiedActionId === itemId);
        if (!action) return false;
        // Menu dismissal is not form retirement. Explicit selected demand
        // keeps the same Account/projection owner until the form settles.
        setActionDemand(true);
        const opened = await openPluginContributedAction({ controller, action, signal: scope.signal, anchor: selection?.anchor });
        if (opened.kind !== 'form' || opened.form.isRetired()) {
            if (!scope.signal.aborted) setActionDemand(false);
        } else {
            const form = opened.form;
            formRef.current = form;
            unsubscribeForm.current = form.subscribe(() => {
                if (!form.isRetired()) return;
                unsubscribeForm.current?.();
                unsubscribeForm.current = null;
                formRef.current = null;
                if (!scope.signal.aborted) setActionDemand(false);
            });
        }
        return true;
    }, [actions, controller, scope]);
    return { items, select };
}
