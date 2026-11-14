import * as React from 'react';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope, useSessionMessages, useSessionSelector } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { resolveHydratedServerIdForRouteResult, type SessionRouteEncryptionReader } from '@/hooks/session/routeHydrationSnapshot';
import { sync } from '@/sync/sync';
import { useShallow } from 'zustand/react/shallow';
import { SessionPullRequestStatusResourceResultV1Schema,
    TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useSessionMachineDisplayIdentity } from '@/components/sessions/model/useSessionMachineTarget';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readCurrentAppShellPluginUiProjection, subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { readPluginUiResourceProjection } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginContextualResourceBinding } from '@/components/plugins/surfaces/pluginResourceBinding';
import { usePluginSessionSurfaceTarget } from '@/components/plugins/surfaces/pluginSurfaceContext';
import { acquirePluginContextualResourceStore, resourceBindingKey,
    type PluginContextualResourceStoreLease } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import {
    projectDeploymentPreparationRead,
    type DeploymentPreparationRead, type DeploymentPreparationPullRequestRead,
} from './deploymentPreparationRead';

const PULL_REQUEST_RESOURCE = Object.freeze({ pluginId: 'happier.triage', localId: TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 });

/** Local Session facts and the incumbent shared Session PR Resource have separate subscriptions. */
export function useDeploymentPreparationRead(lifetime: ServerAccountScopeLifetime, address: SessionAddress): DeploymentPreparationRead {
    const { serverId, sessionId } = address;
    const session = React.useMemo(() => ({ serverId, sessionId }), [serverId, sessionId]);
    const presented = useLayoutPresentationActive();
    const activeScope = useActiveServerAccountScope(serverId);
    const subscribeCurrent = React.useCallback((notify: () => void) => {
        const subscription = lifetime.onRetire(notify);
        return () => subscription.dispose();
    }, [lifetime]);
    const readCurrent = React.useCallback(() => lifetime.isCurrent()
        && areServerAccountScopesEqual(lifetime.scope, activeScope), [activeScope, lifetime]);
    const current = React.useSyncExternalStore(subscribeCurrent, readCurrent, readCurrent);
    const enabled = current && presented;
    const local = useSessionSelector(enabled ? sessionId : '', serverId, useShallow(value => ({
        present: value !== null,
        workState: value ? readSessionOwnerMetadataView(value)?.sessionWorkStateV1 ?? null : null,
        agentId: value ? readSessionPresentationAgentId(value) : null,
    })));
    const ownerMetadata = React.useMemo(() => ({ sessionWorkStateV1: local.workState }), [local.workState]);
    const [hydrated, setHydrated] = React.useState<Readonly<{
        lifetime: ServerAccountScopeLifetime; session: SessionAddress;
    }> | null>(null);
    React.useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        let readEncryption: SessionRouteEncryptionReader | undefined;
        const retirement = lifetime.onRetire(() => { cancelled = true; });
        void sync.ensureSessionVisibleForMessageRoute(sessionId, { serverId, hydrateMessages: true,
            includeTurnsProjection: false,
            onHydratedSessionReader: read => { readEncryption = read; },
        }).then(result => {
            if (!cancelled && lifetime.isCurrent() && result.kind === 'available'
                && resolveHydratedServerIdForRouteResult(sessionId, serverId, result, readEncryption) !== null) {
                setHydrated({ lifetime, session });
            }
        }).catch(() => { /* An unread transcript remains unknown until its owner can hydrate it. */ });
        return () => { cancelled = true; retirement.dispose(); };
    }, [enabled, lifetime, serverId, session, sessionId]);
    // The ambient transcript store is safe only after the addressed owner has
    // admitted it for this exact, still-applied Home and Account.
    const transcriptEnabled = enabled && local.present && hydrated?.lifetime === lifetime && hydrated.session === session;
    const { messages } = useSessionMessages(sessionId, { enabled: transcriptEnabled, textUpdates: false });
    const runtime = useSessionPluginRuntime({ address: current ? session : null });
    const machine = useSessionMachineDisplayIdentity(enabled ? sessionId : '', serverId);
    const readDeclaration = React.useCallback(() => current ? readPluginUiResourceProjection(
        readCurrentAppShellPluginUiProjection({ scope: lifetime.scope, declarationsOnly: true })?.resourcesById,
        PULL_REQUEST_RESOURCE) : null, [current, lifetime]);
    const declaration = React.useSyncExternalStore(subscribeCommittedAppShellPluginUiProjection, readDeclaration, readDeclaration);
    const target = usePluginSessionSurfaceTarget({ sessionId, serverId, authority: lifetime });
    const binding = declaration ? resolvePluginContextualResourceBinding({
        projection: runtime.pluginUiProjection, machineId: runtime.machineId, serverId,
        accountLifetime: lifetime, isCurrent: lifetime.isCurrent,
    }, declaration, { kind: 'session', sessionId, ...(target ? { target } : {}) }) : null;
    const bindingKey = binding ? resourceBindingKey(binding) : null;
    const [acquired, setAcquired] = React.useState<Readonly<{
        key: string; lifetime: ServerAccountScopeLifetime; lease: PluginContextualResourceStoreLease;
    }> | null>(null);
    React.useEffect(() => {
        if (!binding || !bindingKey || !current) return;
        const lease = acquirePluginContextualResourceStore(binding);
        if (!lease) return;
        const value = { key: bindingKey, lifetime, lease };
        setAcquired(value);
        const release = () => { lease.dispose(); setAcquired(previous => previous === value ? null : previous); };
        const retirement = lifetime.onRetire(release);
        return () => { retirement.dispose(); lease.dispose(); };
    }, [bindingKey, current, lifetime]);
    const entry = React.useMemo(() => current && acquired?.key === bindingKey && acquired.lifetime === lifetime
        ? acquired.lease.store.getEntry(PULL_REQUEST_RESOURCE) : null, [acquired, bindingKey, current, lifetime]);
    const subscribeResource = React.useCallback((notify: () => void) => enabled
        ? entry?.subscribe(notify, true) ?? (() => {}) : () => {}, [enabled, entry]);
    const readResource = React.useCallback(() => current ? entry?.getSnapshot() ?? null : null, [current, entry]);
    const resource = React.useSyncExternalStore(subscribeResource, readResource, readResource);
    const content = enabled ? resource?.value : undefined;
    const pullRequests = React.useMemo((): DeploymentPreparationPullRequestRead => {
        if (!content || content.contentType !== 'application/json') return null;
        try {
            const parsed = SessionPullRequestStatusResourceResultV1Schema.safeParse(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content.bytes)));
            return parsed.success && parsed.data.sessionId === sessionId ? parsed.data : null;
        } catch { return null; }
    }, [content, sessionId]);
    const snapshot = React.useMemo(() => projectDeploymentPreparationRead({ session,
        ownerMetadata, messages, pullRequests, agentId: local.agentId, machine: enabled ? machine : null }),
    [enabled, local.agentId, machine, ownerMetadata, messages, pullRequests, session]);
    const publication = snapshot.publication;
    const publicationKey = publication && publication.status !== 'pending' && publication.status !== 'unknown'
        ? publication.key : null;
    const previousPublication = React.useRef<Readonly<{ entry: typeof entry; key: string | null }> | null>(null);
    React.useEffect(() => {
        const previous = previousPublication.current;
        previousPublication.current = { entry, key: publicationKey };
        if (enabled && entry && previous?.entry === entry && publicationKey !== null && previous.key !== publicationKey) {
            void entry.refresh();
        }
    }, [enabled, entry, publicationKey]);
    return snapshot;
}
