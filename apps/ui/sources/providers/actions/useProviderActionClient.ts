import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useServerCredentialAccountScopeStates } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { retryServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveMachineRpcTargetServerId } from '@/sync/runtime/orchestration/serverScopedRpc/resolveMachineRpcTargetServerId';
import * as client from './client';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

const onExecuted = () => {};

/** The Inbox page of one queued Provider approval, on the Home that holds it. */
export function providerApprovalHref(artifactId: string, transportServerId: string): ReturnType<typeof buildApprovalHref> {
    return buildApprovalHref(artifactId, transportServerId);
}

/** The approval a Provider request from this client is waiting for: what to reopen, and where. */
export type ProviderPendingApproval = Readonly<{ artifactId: string; href: ReturnType<typeof buildApprovalHref> }>;

/** Mounted result custody for the exact Home/Account that authored a Provider request. */
export function useProviderActionClient(serverId: string | null | readonly (string | null)[], initiatingLifetime?: ServerAccountScopeLifetime | null) {
    const resolvedServerIds = [...new Set((typeof serverId === 'string' || serverId === null ? [serverId] : serverId)
        .map(id => resolveMachineRpcTargetServerId(id))
        .filter((id): id is string => Boolean(id)))].sort();
    const serverIdsKey = JSON.stringify(resolvedServerIds);
    // The exact Home set, not a caller's freshly allocated array, owns these captures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const requestedServerIds = React.useMemo(() => resolvedServerIds, [serverIdsKey]);
    const scopeStates = useServerCredentialAccountScopeStates(requestedServerIds);
    const bindings = React.useMemo(() => new Map([...scopeStates].flatMap(([id, state]) => (
        state.binding ? [[id, state.binding] as const] : []
    ))), [scopeStates]);
    const unreadableServerIdsKey = JSON.stringify(requestedServerIds.filter(id => (
        scopeStates.get(resolveServerProfileScopeIdForIdentifier(id))?.resolution.kind === 'unavailable'
    )));
    const retryReadiness = React.useCallback(() => {
        for (const id of JSON.parse(unreadableServerIdsKey) as string[]) retryServerCredentialAccountScope(id);
    }, [unreadableServerIdsKey]);
    const lifetimes = React.useMemo(() => new Map(requestedServerIds.flatMap(id => {
        const binding = bindings.get(resolveServerProfileScopeIdForIdentifier(id));
        if (!binding) return [];
        const lifetime = {
            binding, transportServerId: getServerProfileById(id)?.id ?? id, controller: new AbortController(),
            approvalHrefs: new Map<string, ProviderPendingApproval['href']>(),
        };
        return [[resolveServerProfileScopeIdForIdentifier(id), lifetime] as const];
    })), [bindings, requestedServerIds]);
    React.useEffect(() => {
        // React's development effect replay must restore local interest, not a retired Account.
        const retirements = [...lifetimes.values()].map(lifetime => {
            if (lifetime.controller.signal.aborted) lifetime.controller = new AbortController();
            const controller = lifetime.controller;
            const retire = () => { lifetime.approvalHrefs.clear(); controller.abort(); };
            const retirement = lifetime.binding.onRetire(retire);
            return () => { retirement.dispose(); retire(); };
        });
        return () => { for (const retire of retirements) retire(); };
    }, [lifetimes]);
    const scopeKey = JSON.stringify(requestedServerIds.map(id => {
        const binding = bindings.get(resolveServerProfileScopeIdForIdentifier(id));
        return binding ? [serverAccountScopeKeySuffix(binding.scope), binding.revision] : ['unbound', id];
    }));
    const approval = useActionApprovalContinuation({ scopeKey, serverId: requestedServerIds[0] ?? '', onExecuted });
    const methods = React.useMemo(() => {
        function bind<Input extends Readonly<{ serverId: string | null }>, Output>(
            method: (input: Input, approval?: client.ProviderActionApprovalOptions) => Promise<Output>,
        ): (input: Input, options?: Pick<client.ProviderActionApprovalOptions, 'confirmed' | 'interactivePresentation'> & Readonly<{ signal?: AbortSignal; retainInvocationSignal?: AbortSignal;
            onApprovalPending?: (registration: ActionApprovalRegistration) => void }>) => Promise<Output> {
            return async (input, options) => {
                const targetServerId = input.serverId ?? (requestedServerIds.length === 1 ? requestedServerIds[0] : null);
                const lifetime = targetServerId ? lifetimes.get(resolveServerProfileScopeIdForIdentifier(targetServerId)) : undefined;
                const binding = lifetime?.binding;
                if (!binding || !lifetime || !binding.isCurrent() || lifetime.controller.signal.aborted
                    || initiatingLifetime === null || (initiatingLifetime && (!initiatingLifetime.isCurrent()
                        || !areServerAccountScopesEqual(initiatingLifetime.scope, binding.scope)))) {
                    throw createProviderErrorV1('provider_authorization_changed');
                }
                // Request cancellation does not opt into retained approval delivery.
                // Joined observations belong to remaining demand. The exact credential
                // binding still retires the request synchronously.
                const retained = options?.retainInvocationSignal ? new AbortController() : null;
                const retirement = retained ? subscribeHomeCredentialChange(event => {
                    if (areServerProfileIdentifiersEquivalent(event.serverId, binding.scope.serverId)) retained.abort();
                }) : null;
                const cancellation = mergeAbortSignals([retained?.signal ?? lifetime.controller.signal, options?.signal,
                    options?.retainInvocationSignal]);
                const signal = cancellation.signal ?? lifetime.controller.signal;
                let pendingArtifactId: string | null = null;
                try {
                    return await method(input, {
                        ...(options?.confirmed ? { confirmed: options.confirmed } : {}),
                        ...(options?.interactivePresentation ? { interactivePresentation: options.interactivePresentation } : {}),
                        scope: binding.scope,
                        signal,
                        ...(options?.retainInvocationSignal ? { retainInvocationSignal: options.retainInvocationSignal } : {}),
                        onApprovalPending: registration => {
                            if ((retained ? retained.signal.aborted : !binding.isCurrent()) || signal.aborted) return;
                            const artifactId = typeof registration === 'string' ? registration : registration.artifactId;
                            pendingArtifactId = artifactId;
                            options?.onApprovalPending?.(registration);
                            lifetime.approvalHrefs.set(artifactId, providerApprovalHref(artifactId, lifetime.transportServerId));
                            approval.requestApproval(registration);
                        },
                    });
                } finally {
                    cancellation.dispose();
                    retirement?.();
                    if (pendingArtifactId) lifetime.approvalHrefs.delete(pendingArtifactId);
                }
            };
        }
        return {
            describeProviderConnections: bind(client.describeProviderConnections),
            mutateProviderConnection: bind(client.mutateProviderConnection),
            probeProviderConnection: bind(client.probeProviderConnection),
            refreshProviderConnectionUsage: bind(client.refreshProviderConnectionUsage),
            probeProviderDraft: bind(client.probeProviderDraft),
            describeProviderModels: bind(client.describeProviderModels),
            describeProviderConnectionModels: bind(client.describeProviderConnectionModels),
            loadProviderModel: bind(client.loadProviderModel),
            cancelProviderModelLoad: bind(client.cancelProviderModelLoad),
            mutateProviderModelSettings: bind(client.mutateProviderModelSettings),
            setProviderModelPickerVisibility: bind(client.setProviderModelPickerVisibility),
            setProviderDefaultModelSelection: bind(client.setProviderDefaultModelSelection),
            describeProviderBindingStatus: bind(client.describeProviderBindingStatus),
            prepareLegacyProfileMigrationSource: bind(client.prepareLegacyProfileMigrationSource),
            previewLegacyProfileMigration: bind(client.previewLegacyProfileMigration),
            confirmLegacyProfileMigration: bind(client.confirmLegacyProfileMigration),
            confirmLegacyProfileMigrationConflict: bind(client.confirmLegacyProfileMigrationConflict),
        };
    }, [approval.requestApproval, initiatingLifetime, lifetimes, requestedServerIds]);
    let pendingApprovalHref: ProviderPendingApproval['href'] | null = null;
    if (approval.approvalPending && approval.approvalId) {
        for (const lifetime of lifetimes.values()) {
            const href = lifetime.approvalHrefs.get(approval.approvalId);
            if (href) { pendingApprovalHref = href; break; }
        }
    }
    const pendingApproval = React.useMemo<ProviderPendingApproval | null>(() => (
        approval.approvalId && pendingApprovalHref ? { artifactId: approval.approvalId, href: pendingApprovalHref } : null
    ), [approval.approvalId, pendingApprovalHref]);
    const resolvedServerId = requestedServerIds.length === 1 ? requestedServerIds[0] : null;
    const accountScope = resolvedServerId
        ? scopeStates.get(resolveServerProfileScopeIdForIdentifier(resolvedServerId))
        : undefined;
    // Readiness means the credential read settled, not that it authorized an
    // Action. Terminal refusals must reach bind's typed error rather than leave
    // every read hook waiting forever. bind remains the authority check.
    return { ...methods, scopeKey, scopeStates, accountScope: accountScope ?? { resolution: { kind: resolvedServerId ? 'resolving' as const : 'unknown_home' as const }, binding: null }, pendingApproval, retryReadiness, ready: initiatingLifetime !== null && requestedServerIds.length > 0 && requestedServerIds.every(id => {
        const state = scopeStates.get(resolveServerProfileScopeIdForIdentifier(id));
        if (!state || state.resolution.kind === 'resolving') return false;
        if (state.resolution.kind === 'unavailable') return true;
        const binding = state.binding;
        return state.resolution.kind === 'bound' && binding?.isCurrent() === true
            && (!initiatingLifetime || (initiatingLifetime.isCurrent()
                && areServerAccountScopesEqual(initiatingLifetime.scope, binding.scope)));
    }) };
}
