import * as React from 'react';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useActiveServerAccountScope, useIsDataReady, useSetting } from '@/sync/domains/state/storage';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { captureAccountEncryptionObservationForHome } from '@/sync/http/accountEncryptionObservationBinding';
import { createAccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';
import { subscribeKvPrefixChanges } from '@/sync/engine/socket/kvUpdateDispatcher';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS, scheduleDebouncedPendingSettingsFlush } from '@/sync/engine/pending/pendingSettings';
import { InvalidateSync } from '@/utils/sessions/sync';
import { parseToken } from '@/utils/auth/parseToken';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { CompactAppDestination } from '../destinations/compactAppDestinationCatalog';
import type { useWorkspaceState } from './useWorkspaceState';
import type { WorkspaceAction } from './workspaceState';
import { collectWorkspaceTabIntents, projectWorkspaceSharedTabs, type SharedWorkspaceTabs, type WorkspaceTabIntent } from './workspaceSyncedTabs';
import { createWorkspaceTabsSync, type WorkspaceTabsSyncSnapshot } from './workspaceTabsSync';
import { createWorkspaceTabsHandoffPublisher, WorkspaceTabsHandoffSourceUnavailableError, type WorkspaceTabsHandoffSource, type WorkspaceTabsHandoffPublisher } from './workspaceTabsHandoff';
import { normalizeWorkspaceSingletonTabs, workspaceDestinationAdmissionIdentity, workspaceSingletonDestinationIds } from './workspaceDestinationPolicy';

export type WorkspaceTabSyncStatus = WorkspaceTabsSyncSnapshot['status'] | 'off';
type LocalOwner = ReturnType<typeof useWorkspaceState>;
type Runtime = Readonly<{
    accept: (intents: readonly WorkspaceTabIntent[], projection: SharedWorkspaceTabs) => void;
    policyChanged: () => void;
    reconcileLocal: () => void;
}>;
type PublishedProjection = Readonly<{
    binding: string;
    credentials: AuthCredentials | null;
    snapshot: WorkspaceTabsSyncSnapshot;
    source: WorkspaceTabsHandoffSource | null;
    isCurrent?: () => boolean;
}>;

function enrollmentIntents(record: SharedWorkspaceTabs): readonly WorkspaceTabIntent[] {
    const opened: WorkspaceTabIntent[] = record.order.map(id => ({ type: 'open', tab: record.tabsById[id] }));
    if (record.pairs.length) opened.push({ type: 'pairs', pairs: record.pairs });
    return opened;
}

export function useWorkspaceTabSync(input: Readonly<{
    local: LocalOwner;
    catalog: readonly CompactAppDestination[];
    enabled: boolean;
}>): LocalOwner & Readonly<{
    sharedTabs: SharedWorkspaceTabs | null;
    tabSyncStatus: WorkspaceTabSyncStatus;
    handoffSource: WorkspaceTabsHandoffSource | null;
}> {
    const credentials = useOptionalAuth()?.credentials ?? null;
    const credentialAccountId = React.useMemo(() => {
        try { return credentials ? parseToken(credentials.token) : null; }
        catch { return null; } // Malformed tokens cannot establish an Account binding.
    }, [credentials?.token]);
    const syncEnabled = useSetting('workspaceTabsSyncEnabled') !== false;
    const dataReady = useIsDataReady();
    const scope = useActiveServerAccountScope();
    const server = useActiveServerSnapshot(input.enabled && credentials !== null);
    const carrier = credentials ? getActiveServerHomeCarrier() : null;
    const singletonPolicyKey = React.useMemo(() => JSON.stringify([...workspaceSingletonDestinationIds(input.catalog)].sort()), [input.catalog]);
    const binding = JSON.stringify([scope?.serverId, scope?.accountId, server.serverId, server.serverUrl,
        server.generation, server.runtimeOrigin, server.carrier, credentials?.token, input.local.windowId,
        input.enabled, input.local.isReady, dataReady, syncEnabled]);
    const latest = React.useRef({ ...input, binding, credentials });
    latest.current = { ...input, binding, credentials };
    const runtime = React.useRef<Runtime | null>(null);
    const [published, setPublished] = React.useState<PublishedProjection>({ binding, credentials,
        snapshot: { status: 'pending', record: null }, source: null });
    const accountKey = scope ? JSON.stringify([scope.serverId, scope.accountId]) : null;
    const readyForEnrollment = dataReady && input.local.isReady;
    const preference = React.useRef({ accountKey, enabled: syncEnabled, ready: readyForEnrollment });
    const deliberateEnrollment = React.useRef(false);
    // Hydrating settings before the layout is ready is not an explicit enable.
    if (preference.current.accountKey === accountKey && preference.current.ready && readyForEnrollment
        && !preference.current.enabled && syncEnabled) deliberateEnrollment.current = true;
    if (preference.current.accountKey !== accountKey) deliberateEnrollment.current = false;
    preference.current = { accountKey, enabled: syncEnabled, ready: readyForEnrollment };

    React.useEffect(() => {
        runtime.current = null;
        setPublished({ binding, credentials, snapshot: { status: 'pending', record: null }, source: null });
        if (!input.enabled || !dataReady || !input.local.isReady || !scope || !credentials
            || credentialAccountId !== scope.accountId || scope.serverId !== server.serverId || !server.serverUrl || !input.local.windowId) {
            setPublished({ binding, credentials, snapshot: { status: 'unavailable', record: null }, source: null });
            return;
        }
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || lifetime.scope.serverId !== scope.serverId || lifetime.scope.accountId !== scope.accountId) {
            setPublished({ binding, credentials, snapshot: { status: 'unavailable', record: null }, source: null });
            return;
        }
        let stopped = false;
        const shouldContinue = () => {
            const current = getActiveServerSnapshot();
            return !stopped && lifetime.isCurrent() && latest.current.binding === binding && latest.current.credentials === credentials
                && current.serverId === server.serverId && current.serverUrl === server.serverUrl
                && current.generation === server.generation && current.runtimeOrigin === server.runtimeOrigin
                && current.carrier === server.carrier && getActiveServerHomeCarrier() === carrier;
        };
        const accountEncryptionObservation = captureAccountEncryptionObservationForHome({
            serverId: server.serverId, endpointUrl: server.serverUrl, credentials, isCurrent: shouldContinue,
        });
        const request = createServerFetchAtEndpoint({ endpointUrl: server.serverUrl, serverId: server.serverId,
            ...(server.runtimeOrigin ? { runtimeOrigin: server.runtimeOrigin } : {}),
            ...(carrier ? { homeCarrier: carrier } : {}), credentials, isCurrent: shouldContinue, accountEncryptionObservation });
        const normalizeRecord = (record: SharedWorkspaceTabs) => normalizeWorkspaceSingletonTabs(record, latest.current.catalog);
        const controller = syncEnabled ? createWorkspaceTabsSync({
            transport: createAccountKvJsonTransport({ credentials, request, key: 'workspace:tabs:v1', shouldContinue }),
            shouldContinue, normalizeRecord,
            destinationIdentity: target => workspaceDestinationAdmissionIdentity(target, latest.current.catalog),
            getLocalRecord: () => projectWorkspaceSharedTabs(latest.current.local.getState()),
            onRecord: (_record, localRecord) => {
                if (!shouldContinue()) return;
                latest.current.local.applySharedRecord(localRecord);
            },
            onStatus: value => {
                if (shouldContinue()) setPublished(current => ({ binding, credentials, snapshot: value, isCurrent: shouldContinue,
                    source: current.binding === binding && current.credentials === credentials ? current.source : null }));
            },
            enroll: () => {
                const local = projectWorkspaceSharedTabs(latest.current.local.getState());
                return enrollmentIntents(local);
            },
        }) : null;
        if (controller && deliberateEnrollment.current) {
            const local = projectWorkspaceSharedTabs(input.local.getState());
            controller.enqueue(enrollmentIntents(local));
            deliberateEnrollment.current = false;
        }
        let refreshRequested = true;
        const sharedSync = new InvalidateSync(async () => {
            if (!controller || !shouldContinue()) return;
            if (refreshRequested) {
                refreshRequested = false;
                try { await controller.refresh(); } catch (error) { refreshRequested = true; throw error; }
            }
            await controller.flush();
        });
        let publisher: WorkspaceTabsHandoffPublisher | null = null;
        try {
            if (!syncEnabled) {
                publisher = createWorkspaceTabsHandoffPublisher({ windowId: input.local.windowId, credentials, request, shouldContinue });
                setPublished({ binding, credentials, snapshot: { status: 'pending', record: null }, source: publisher.source, isCurrent: shouldContinue });
            }
        } catch (error) {
            if (!(error instanceof WorkspaceTabsHandoffSourceUnavailableError)) throw error;
        }
        let handoffRecord: SharedWorkspaceTabs | null = null;
        const handoffSync = new InvalidateSync(async () => {
            const record = handoffRecord;
            if (!publisher || !record || !shouldContinue()) return;
            await publisher.publish(record);
            if (handoffRecord === record) handoffRecord = null;
        });
        let timer: ReturnType<typeof setTimeout> | null = null;
        let dirty = false;
        const refresh = () => { if (controller && shouldContinue()) { refreshRequested = true; sharedSync.invalidate(); } };
        const mounted: Runtime = { reconcileLocal: () => {
            if (shouldContinue()) controller?.reconcileLocal();
        }, policyChanged: () => {
            if (!shouldContinue()) return;
            controller?.reproject();
            refresh();
        }, accept: (intents, projection) => {
            if (!shouldContinue()) return;
            controller?.enqueue(intents);
            handoffRecord = normalizeRecord(projection);
            scheduleDebouncedPendingSettingsFlush({ getTimer: () => timer, setTimer: value => { timer = value; },
                markDirty: () => { dirty = true; }, consumeDirty: () => { const value = dirty; dirty = false; return value; },
                flush: () => { if (shouldContinue()) { sharedSync.invalidate(); handoffSync.invalidate(); } },
                delayMs: ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS });
        } };
        runtime.current = mounted;
        const unsubscribeKv = subscribeKvPrefixChanges('workspace:', changes => {
            if (changes.some(change => change.key === 'workspace:tabs:v1')) refresh();
        }, { credentials, shouldContinue });
        const unsubscribeReconnect = apiSocket.onReconnected(refresh);
        if (controller) sharedSync.invalidate();
        return () => {
            stopped = true;
            if (runtime.current === mounted) runtime.current = null;
            if (timer) clearTimeout(timer);
            sharedSync.stop(); handoffSync.stop(); controller?.stop(); publisher?.stop();
            unsubscribeKv(); unsubscribeReconnect();
        };
    }, [binding, carrier, credentials]);

    React.useLayoutEffect(() => { runtime.current?.policyChanged(); }, [singletonPolicyKey]);

    const dispatch = React.useCallback((action: WorkspaceAction) => {
        const local = latest.current.local;
        const before = local.getState();
        local.dispatch(action);
        const after = local.getState();
        const intents = collectWorkspaceTabIntents(before, after, action);
        if (intents.length) runtime.current?.accept(intents, projectWorkspaceSharedTabs(after));
        // Presentation-only navigation has no shared intent. Reconsider deferred
        // closes against the already observed record after collecting user edits,
        // so retiring a background instance never becomes a new shared Close.
        runtime.current?.reconcileLocal();
    }, []);
    const restoreAction = React.useCallback((action: WorkspaceAction) => {
        latest.current.local.restoreAction(action);
        runtime.current?.reconcileLocal();
    }, []);
    const offProjection = React.useMemo(() => syncEnabled ? null : projectWorkspaceSharedTabs(input.local.state), [input.local.state, syncEnabled]);
    const visible = published.binding === binding && published.credentials === credentials && (published.isCurrent?.() ?? true)
        ? published : null;
    return { ...input.local, dispatch, restoreAction, sharedTabs: syncEnabled ? visible?.snapshot.record ?? null : offProjection,
        tabSyncStatus: syncEnabled ? visible?.snapshot.status ?? 'pending' : 'off', handoffSource: visible?.source ?? null };
}
