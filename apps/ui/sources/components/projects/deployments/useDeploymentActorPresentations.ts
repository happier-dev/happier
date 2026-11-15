import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ActionActorV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDiscussionParticipantProfiles } from '@/components/discussions/useDiscussionParticipantProfiles';
import { resolveAccountActorPresentation, resolveUnknownAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import { getStorage } from '@/sync/domains/state/storageStore';
import { refreshWorkflowRunsByIds } from '@/sync/engine/workflows/refreshWorkflowRun';
import { readAutomationDefinitionDisplaysByIds } from '@/sync/engine/automations/syncAutomations';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';

export type DeploymentActorPresentation = Readonly<{
    actorKind: ActionActorV1['actorKind'] | null;
    displayName: string | null;
    onBehalfOf: Readonly<{ serverId: string; accountId: string; displayName: string }> | null;
}>;

/** Display facts for the admitted actors, in the same order as the supplied records. */
export function useDeploymentActorPresentations(input: Readonly<{
    actors: readonly (ActionActorV1 | null | undefined)[];
    scope: ServerAccountScope;
    accountLifetime: ServerAccountScopeLifetime | null;
    active: boolean;
}>): readonly DeploymentActorPresentation[] {
    const { actors, scope, accountLifetime } = input;
    const subscribe = React.useCallback((notify: () => void) => {
        const retirement = accountLifetime?.onRetire(notify);
        return () => retirement?.dispose();
    }, [accountLifetime]);
    const isCurrent = React.useSyncExternalStore(subscribe,
        () => accountLifetime?.isCurrent() === true && areServerAccountScopesEqual(accountLifetime.scope, scope),
        () => false);
    const active = input.active && isCurrent;
    const accountIds = active ? actors.flatMap(actor => actor?.actorKind === 'person' ? [actor.accountId]
        : actor?.onBehalfOf && areServerProfileIdentifiersEquivalent(actor.onBehalfOf.serverId, scope.serverId)
            ? [actor.onBehalfOf.accountId] : []) : [];
    const people = useDiscussionParticipantProfiles({ scope, roster: null, accountIds,
        enabled: active && accountIds.length > 0, accountLifetime });

    const sessionIdsKey = JSON.stringify(active ? [...new Set(actors.flatMap(actor => actor?.actorKind === 'agent' ? [actor.sessionId] : []))].sort() : []);
    const sessionIds = React.useMemo<readonly string[]>(() => JSON.parse(sessionIdsKey), [sessionIdsKey]);
    const addresses = React.useMemo(() => sessionIds.map(sessionId => ({ serverId: scope.serverId, sessionId })), [sessionIds, scope.serverId]);
    useSessionContentDemand(addresses, { tag: 'deployment-actor-presentations', hydrate: 'unsettled',
        contentDemand: 'list-display', active });
    const targets = getStorage()(useShallow(state => sessionIds.map(sessionId =>
        readSessionListRowForServerId(state.sessionListRowsByServerId, scope.serverId, sessionId)?.agentTargetKey ?? null)));
    const namesBySessionId = React.useMemo(() => new Map(sessionIds.map((sessionId, index) => {
        const target = targets[index];
        return [sessionId, target ? resolveAgentCatalogTitle(target) : null] as const;
    })), [sessionIds, targets]);

    const runIdsKey = JSON.stringify(active ? [...new Set(actors.flatMap(actor => actor?.actorKind === 'workflow' ? [actor.runId] : []))].sort() : []);
    const runIds = React.useMemo<readonly string[]>(() => JSON.parse(runIdsKey), [runIdsKey]);
    const automationReferencesKey = JSON.stringify(active ? actors.flatMap(actor => actor?.actorKind === 'workflow' && actor.automationId
        ? [[actor.runId, actor.automationId]] : []).sort() : []);
    const automationReferences = React.useMemo<readonly (readonly [string, string])[]>(() => JSON.parse(automationReferencesKey), [automationReferencesKey]);
    const automationIds = React.useMemo(() => [...new Set(automationReferences.map(([, automationId]) => automationId))], [automationReferences]);
    const [automationDisplayRead, setAutomationDisplayRead] = React.useState<Readonly<{
        lifetime: ServerAccountScopeLifetime;
        names: readonly Readonly<{ automationId: string; displayName: string }>[];
    }> | null>(null);
    // A raw direct detail can retain its server-readable placeholder name.
    // Store pushes invalidate the display observation; only the opener supplies names.
    const automationDisplaySignals = getStorage()(useShallow(state => automationIds.map(automationId => {
        const definition = state.profileScope && areServerAccountScopesEqual(state.profileScope, scope)
            ? state.automations[automationId] : null;
        return definition ? JSON.stringify([definition.templateVersion, definition.name]) : null;
    })));
    const namesByAutomationId = React.useMemo(() => new Map(active && automationDisplayRead?.lifetime === accountLifetime
        ? automationDisplayRead.names.map(value => [value.automationId, value.displayName] as const) : []),
    [active, accountLifetime, automationDisplayRead]);
    const runTitles = getStorage()(useShallow(state => runIds.map(runId => {
        const metadata = state.workflowRunsById[workflowRunStoreKey(runId, scope)]?.metadata;
        return metadata?.kind === 'available' ? metadata.value.title : null;
    })));
    const namesByRunId = React.useMemo(() => new Map(runIds.map((runId, index) => [runId, runTitles[index] ?? null] as const)), [runIds, runTitles]);
    React.useEffect(() => {
        if (!active || !accountLifetime || runIds.length === 0) return;
        const state = getStorage().getState();
        const missing = runIds.filter(runId => !state.workflowRunsById[workflowRunStoreKey(runId, accountLifetime.scope)]?.summary);
        const abort = new AbortController();
        const retirement = accountLifetime.onRetire(() => abort.abort());
        // Accepted Run titles take priority. Scheduled Actions can have no Workflow
        // snapshot, so only their missing titles demand the private definition display.
        void (async () => {
            if (missing.length > 0) await refreshWorkflowRunsByIds(missing, { accountLifetime, fence: accountLifetime, signal: abort.signal }).catch(() => {});
            if (abort.signal.aborted) return;
            const current = getStorage().getState();
            const definitions = [...new Set(automationReferences.flatMap(([runId, automationId]) => {
                const metadata = current.workflowRunsById[workflowRunStoreKey(runId, accountLifetime.scope)]?.metadata;
                return metadata?.kind === 'available' && metadata.value.title ? [] : [automationId];
            }))];
            if (definitions.length === 0) return;
            const names = await readAutomationDefinitionDisplaysByIds(definitions, { accountLifetime, signal: abort.signal });
            if (!abort.signal.aborted) setAutomationDisplayRead({ lifetime: accountLifetime, names });
        })().catch(() => {});
        return () => { retirement.dispose(); abort.abort(); };
    }, [active, accountLifetime, runIds, automationReferences, automationDisplaySignals]);

    return React.useMemo(() => {
        const personName = (accountId: string): string | null => {
            if (!active) return null;
            const person = people.accounts.get(accountId);
            return person ? resolveAccountActorPresentation(person, scope).name
                : people.status === 'loading' ? null : resolveUnknownAccountActorName('value');
        };
        return actors.map((actor): DeploymentActorPresentation => {
            if (!actor) return { actorKind: null, displayName: null, onBehalfOf: null };
            if (actor.actorKind === 'person') return { actorKind: 'person', displayName: personName(actor.accountId), onBehalfOf: null };
            const reference = actor.onBehalfOf;
            const onBehalfOf = reference ? { ...reference, displayName:
                (areServerProfileIdentifiersEquivalent(reference.serverId, scope.serverId) ? personName(reference.accountId) : null)
                    ?? resolveUnknownAccountActorName('value') } : null;
            return { actorKind: actor.actorKind, displayName: actor.actorKind === 'agent'
                ? namesBySessionId.get(actor.sessionId) ?? null : namesByRunId.get(actor.runId)
                    ?? (actor.automationId ? namesByAutomationId.get(actor.automationId) : null) ?? null, onBehalfOf };
        });
    }, [actors, active, scope, people.accounts, people.status, namesBySessionId, namesByRunId, namesByAutomationId]);
}
