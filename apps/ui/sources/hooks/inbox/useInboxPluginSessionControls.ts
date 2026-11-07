import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { InboxPluginSessionControl, InboxPluginSessionRow } from '@/components/inbox/inboxItemProjection';
import { dispatchPluginDeclarativeButton, type PluginDeclarativeButtonDispatchOutcome } from '@/components/plugins/surfaces/pluginDeclarativeButtonDispatch';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { storage } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { resolveActionsSettingsV1FromState } from '@/sync/domains/settings/actionsSettings';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { admitInternalRouteHref } from '@/utils/path/routeUtils';

export type InboxPluginSessionControlInvoker = (
    row: InboxPluginSessionRow, controlId: string, options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<PluginDeclarativeButtonDispatchOutcome>;

/** Row data describes intent; the viewer's existing catalog and policy supply affordances. */
export function useInboxPluginSessionControls(rows: readonly InboxPluginSessionRow[]): Readonly<{
    rows: readonly InboxPluginSessionRow[];
    invokeControl: InboxPluginSessionControlInvoker;
}> {
    const router = useRouter();
    const runtime = useAppShellPluginUiProjection();
    const presented = useLayoutPresentationActive();
    const lifetime = runtime.accountLifetime;
    const projection = runtime.pluginUiProjection;
    const localize = usePluginLocalizedTextResolver({ projection });
    const settings = storage(useShallow(state => ({
        current: areAccountSettingsScopesEqual(state.settingsScope, lifetime?.scope),
        raw: state.settings.actionsSettingsV1,
    })), { settings: ['actionsSettingsV1'], settingsScope: true });
    const policy = React.useMemo(() => resolveActionsSettingsV1FromState({ settings: { actionsSettingsV1: settings.raw } }), [settings.raw]);
    const active = presented && runtime.phase === 'current' && runtime.interactionEnabled && lifetime?.isCurrent() === true;
    const projectRow = React.useMemo(() => {
        const resolveAction = createPluginUiProjectedActionResolver(projection?.actionsById);
        // The index owner retains unchanged source rows. Keep that identity through
        // presentation too, so another row's update cannot retire an in-flight press.
        const projected = new WeakMap<InboxPluginSessionRow, InboxPluginSessionRow>();
        return (row: InboxPluginSessionRow): InboxPluginSessionRow => {
            if (!row.row.controls?.length) return row;
            const retained = projected.get(row);
            if (retained) return retained;
            const controls: InboxPluginSessionControl[] = [];
            if (active && areServerAccountScopesEqual(row.detailBinding?.accountLifetime.scope, lifetime?.scope)) {
                for (const button of row.row.controls) {
                    if (button.effect.kind === 'open') {
                        controls.push({ id: button.id, label: localize(row.pluginId, button.label), effect: button.effect });
                        continue;
                    }
                    const identity = button.effect.invocation.action;
                    const action = resolveAction(identity);
                    if (!settings.current || !action?.available || !action.occurrenceId || !action.surfaces.includes('ui')
                        || !isActionEnabledByActionsSettings(formatQualifiedPluginActionId(identity), policy, { surface: 'ui' })) continue;
                    controls.push({ id: button.id, label: localize(row.pluginId, button.label), effect: button.effect,
                        action: { identity, qualifiedId: buildQualifiedPluginContributionKey(identity),
                        occurrenceId: action.occurrenceId, enabled: true,
                        title: resolvePluginProjectedActionPresentation({ pluginId: identity.pluginId,
                            presentation: action, projection, localize }).title,
                        ...(action.icon ? { icon: action.icon } : {}),
                    } });
                }
            }
            const result = { ...row, controls };
            projected.set(row, result);
            return result;
        };
    }, [active, lifetime, projection, localize, settings.current, policy]);
    const projectedRows = React.useMemo(() => rows.map(projectRow), [rows, projectRow]);
    const latest = React.useRef({ rows: projectedRows, lifetime, active });
    latest.current = { rows: projectedRows, lifetime, active };
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const invokeControl = React.useCallback<InboxPluginSessionControlInvoker>(async (row, controlId, options) => {
        const captured = latest.current;
        const lifetime = captured.lifetime;
        const isCurrent = () => mounted.current && !options?.signal?.aborted && lifetime?.isCurrent() === true
            && latest.current.active && latest.current.lifetime === lifetime && latest.current.rows.includes(row);
        const button = row.row.controls?.find(control => control.id === controlId);
        if (!lifetime || !button || !row.controls?.some(control => control.id === controlId) || !isCurrent()) return { kind: 'unavailable' };
        const outcome = await dispatchPluginDeclarativeButton({ button, ownerPluginId: row.pluginId, scope: lifetime.scope,
            sessionId: row.row.session.sessionId, defaultRoute: createActivitySurfaceSessionRoute(row.row.session.sessionId, lifetime.scope.serverId),
            isCurrent, ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (outcome.kind === 'open') {
            if (!isCurrent()) return { kind: 'unavailable' };
            router.push(admitInternalRouteHref(outcome.route));
        }
        return outcome;
    }, [router]);
    return React.useMemo(() => ({ rows: projectedRows, invokeControl }), [projectedRows, invokeControl]);
}
