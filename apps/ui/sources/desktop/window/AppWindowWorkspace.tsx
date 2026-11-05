import * as React from 'react';
import { useAuth } from '@/auth/context/AuthContext';
import type { CompactAppDestination, DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { parseWorkspaceLayout, workspaceLayoutScopeKey } from '@/components/appShell/workspace/workspacePersistence';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { workspaceLayoutsState } from '@/sync/domains/state/filePaneUiState';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import { t } from '@/text';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { scmReviewComparisonOfSource } from '@/sync/domains/scm/diffSummary/selection';
import { AppWindowRecordSchema, readDesktopAppWindowRecord, type AppWindowRecord } from './appWindowBoot';
import { resolveDesktopWindowContext } from './isDesktopAuxiliaryWindowContext';
import { failDesktopAppWindow } from './appWindowRuntime';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolvePaneTabParentDestination } from '@/components/appShell/panes/paneTabWindowTransfer';
import { AppWindowRecordContext } from './AppWindowRecordContext';
import { DesktopDestinationWindow } from './DesktopDestinationWindow';

export { useDesktopAppWindowRecord } from './AppWindowRecordContext';

function initialTarget(record: AppWindowRecord): DestinationRef | null {
    if (record.selectedAddress.kind === 'home') return { kind: 'newTab', params: {} };
    if (record.selectedAddress.kind === 'paneTab') {
        const parent = resolvePaneTabParentDestination({ ...record.selectedAddress, serverId: record.homeId, accountId: record.accountId });
        if (parent) return parent;
        // App-wide pane scopes have no resource route. Bootstrap their existing
        // layout context without mounting that layout's destination body.
        const source = parseWorkspaceLayout(workspaceLayoutsState.readStrict(workspaceLayoutScopeKey({
            serverId: record.homeId, accountId: record.accountId, windowId: record.selectedAddress.layoutId,
        }), value => value));
        const selected = source?.groups[source.focusedGroupId]?.activeTabId;
        return selected ? source?.tabs[selected]?.target ?? null : null;
    }
    if (record.selectedAddress.kind === 'destination') return record.selectedAddress.target;
    if (record.selectedAddress.kind === 'session') {
        const destination = record.selectedAddress.destination;
        const comparison = destination ? scmReviewComparisonOfSource(destination.comparison, destination.comparisonId) : null;
        if (destination && !comparison) return null;
        const query = destination && comparison ? serializeSessionPaneUrlState({ details: {
            kind: 'scmReview', comparison, view: destination.view,
            ...(typeof destination.explain === 'boolean' ? { explain: destination.explain } : {}),
        } }) : {};
        return { kind: 'session', params: { id: record.selectedAddress.sessionId, serverId: record.homeId,
            accountId: record.accountId, ...query } };
    }
    const tabId = record.selectedAddress.kind === 'workspaceTab' ? record.selectedAddress.tabId : record.sourceTabId;
    if (!tabId || !record.sourceLayoutId) return null;
    return parseWorkspaceLayout(workspaceLayoutsState.readStrict(workspaceLayoutScopeKey({
        serverId: record.homeId, accountId: record.accountId, windowId: record.sourceLayoutId,
    }), value => value))?.tabs[tabId]?.target ?? null;
}

/** Native metadata precedes local workspace initialization; no tab set is mirrored from main. */
export function AppWindowWorkspace(props: Readonly<{
    catalog: readonly CompactAppDestination[];
    children: React.ReactNode;
}>) {
    const auth = useAuth();
    const authRef = React.useRef(auth);
    authRef.current = auth;
    const scope = useActiveServerAccountScope();
    const [context, setContext] = React.useState<Readonly<{ record: AppWindowRecord; target: DestinationRef }> | null>(null);
    const record = context?.record ?? null;
    const [failed, setFailed] = React.useState(false);
    const switching = React.useRef(false);
    React.useEffect(() => {
        let current = true;
        let published = false;
        let stop: (() => void) | undefined;
        const fail = (next?: AppWindowRecord) => {
            if (!current) return;
            setFailed(true);
            fireAndForget(failDesktopAppWindow(next, 'metadata_unavailable'), { tag: 'AppWindowWorkspace.metadata' });
        };
        const accept = async (next: AppWindowRecord | null) => {
            if (!next) { fail(); return; }
            const target = initialTarget(next);
            if (!target) { fail(next); return; }
            switching.current = true;
            const switched = await setActiveServerAndSwitch({ serverId: next.homeId, scope: 'tab', refreshAuth: authRef.current.refreshFromActiveServer });
            switching.current = false;
            if (switched === 'blocked') { fail(next); return; }
            if (current) { setFailed(false); setContext({ record: next, target }); }
        };
        void (async () => {
            // A retarget publication must win over a slower initial read.
            stop = await listenDesktopHostEvent<unknown>('desktopAppWindow://record', value => {
                published = true;
                const parsed = AppWindowRecordSchema.safeParse(value);
                if (!parsed.success) { fail(); return; }
                void accept(parsed.data).catch(() => fail(parsed.data));
            });
            if (!current) { stop(); return; }
            const initial = await readDesktopAppWindowRecord();
            if (!published) await accept(initial);
        })().catch(() => fail());
        return () => { current = false; stop?.(); };
    }, []);
    React.useEffect(() => {
        if (!record || record.chrome !== 'full' || !scope || switching.current
            || (record.homeId === scope.serverId && record.accountId === scope.accountId)) return;
        const next: AppWindowRecord = { ...record, homeId: scope.serverId, accountId: scope.accountId, selectedAddress: { kind: 'home' } };
        fireAndForget(invokeDesktopHost('desktop_app_window_update', { record: next }).then(() => {
            setContext({ record: next, target: { kind: 'newTab', params: {} } });
        }).catch(() => { setFailed(true); }), { tag: 'AppWindowWorkspace.home' });
    }, [record, scope]);
    const chrome = resolveDesktopWindowContext().chrome;
    const appWindow = React.useMemo(() => context ? { record: context.record, initialTarget: context.target, chrome } : null, [chrome, context]);
    if (failed) return <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />;
    if (!appWindow) return <PaneLoadingFallback />;
    if ((appWindow.record.chrome !== 'full' || auth.isAuthenticated)
        && (scope?.serverId !== appWindow.record.homeId || scope?.accountId !== appWindow.record.accountId)) return <PaneLoadingFallback />;
    return <AppWindowRecordContext.Provider value={record}>
        <WorkspaceProvider enabled={auth.isAuthenticated} appWindow={appWindow} catalog={props.catalog}>
            {appWindow.record.chrome === 'full' ? <DesktopDestinationWindow full>{props.children}</DesktopDestinationWindow> : props.children}
        </WorkspaceProvider>
    </AppWindowRecordContext.Provider>;
}
