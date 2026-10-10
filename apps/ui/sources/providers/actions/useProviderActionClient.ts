import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolveMachineRpcTargetServerId } from '@/sync/runtime/orchestration/serverScopedRpc/resolveMachineRpcTargetServerId';
import * as client from './client';

const onExecuted = () => {};

/** Mounted result custody for the exact Home/Account that authored a Provider request. */
export function useProviderActionClient(serverId: string | null, initiatingLifetime?: ServerAccountScopeLifetime | null) {
    const resolvedServerId = resolveMachineRpcTargetServerId(serverId) ?? null;
    const transportServerId = resolvedServerId ? getServerProfileById(resolvedServerId)?.id ?? resolvedServerId : null;
    const router = useRouter();
    const { binding } = useServerCredentialAccountScopeBinding(resolvedServerId);
    const lifetime = React.useMemo(() => ({ controller: new AbortController() }), [binding]);
    React.useEffect(() => {
        // React's development effect replay must restore local interest, not a retired Account.
        if (lifetime.controller.signal.aborted) lifetime.controller = new AbortController();
        const controller = lifetime.controller;
        const retirement = binding?.onRetire(() => controller.abort());
        return () => { retirement?.dispose(); controller.abort(); };
    }, [binding, lifetime]);
    const scopeKey = binding
        ? `${serverAccountScopeKeySuffix(binding.scope)}:${binding.revision}`
        : JSON.stringify(['unbound', transportServerId]);
    const approval = useActionApprovalContinuation({ scopeKey, serverId: transportServerId ?? '', onExecuted });
    const methods = React.useMemo(() => {
        function bind<Input extends Readonly<{ serverId: string | null }>, Output>(
            method: (input: Input, approval?: client.ProviderActionApprovalOptions) => Promise<Output>,
        ): (input: Input) => Promise<Output> {
            return async input => {
                if (!binding || !binding.isCurrent() || lifetime.controller.signal.aborted
                    || initiatingLifetime === null || (initiatingLifetime && (!initiatingLifetime.isCurrent()
                        || !areServerAccountScopesEqual(initiatingLifetime.scope, binding.scope)))) {
                    throw createProviderErrorV1('provider_authorization_changed');
                }
                return method(input, {
                    scope: binding.scope,
                    signal: lifetime.controller.signal,
                    onApprovalPending: registration => {
                        if (!binding.isCurrent() || lifetime.controller.signal.aborted) return;
                        approval.requestApproval(registration);
                        const artifactId = typeof registration === 'string' ? registration : registration.artifactId;
                        router.push(`/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(transportServerId ?? binding.serverId)}`);
                    },
                });
            };
        }
        return {
            describeProviderConnections: bind(client.describeProviderConnections),
            mutateProviderConnection: bind(client.mutateProviderConnection),
            probeProviderConnection: bind(client.probeProviderConnection),
            probeProviderDraft: bind(client.probeProviderDraft),
            describeProviderModels: bind(client.describeProviderModels),
            describeProviderConnectionModels: bind(client.describeProviderConnectionModels),
            loadProviderModel: bind(client.loadProviderModel),
            cancelProviderModelLoad: bind(client.cancelProviderModelLoad),
            mutateProviderModelSettings: bind(client.mutateProviderModelSettings),
            setProviderModelPickerVisibility: bind(client.setProviderModelPickerVisibility),
            describeProviderBindingStatus: bind(client.describeProviderBindingStatus),
            prepareLegacyProfileMigrationSource: bind(client.prepareLegacyProfileMigrationSource),
            previewLegacyProfileMigration: bind(client.previewLegacyProfileMigration),
            confirmLegacyProfileMigration: bind(client.confirmLegacyProfileMigration),
            confirmLegacyProfileMigrationConflict: bind(client.confirmLegacyProfileMigrationConflict),
        };
    }, [approval.requestApproval, binding, initiatingLifetime, lifetime, router, transportServerId]);
    return { ...methods, ready: binding !== null && binding.isCurrent()
        && initiatingLifetime !== null && (!initiatingLifetime || (initiatingLifetime.isCurrent()
            && areServerAccountScopesEqual(initiatingLifetime.scope, binding.scope))) };
}
