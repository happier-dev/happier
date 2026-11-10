import * as React from 'react';
import type { StoredApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { useAppShellPluginUiProjection, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useApprovalPrincipalName } from './approvalPrincipalReading';
import { readIncomingDiscussionApprovalSource, type IncomingDiscussionApprovalNames } from './actionApprovalPresentation';

/** Shared approval titles consume public names from their existing scoped owners. */
export function useIncomingDiscussionApprovalNames(input: Readonly<{
    actionId?: string | null;
    actionArgs?: unknown;
    executionOriginV1?: StoredApprovalRequestV2['executionOriginV1'];
}>, serverId: string | null): IncomingDiscussionApprovalNames | undefined {
    const source = React.useMemo(() => readIncomingDiscussionApprovalSource({ actionId: input.actionId, actionArgs: input.actionArgs }),
        [input.actionId, input.actionArgs]);
    const { binding } = useServerCredentialAccountScopeBinding(source ? serverId : null);
    const providerPluginId = source?.providerPluginId;
    const providerName = useAppShellPluginUiProjection(React.useCallback((value: AppShellPluginUiProjectionValue) => {
        const lifetime = value.accountLifetime;
        return providerPluginId && binding && lifetime?.isCurrent()
            && lifetime.scope.accountId === binding.scope.accountId
            && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, binding.scope.serverId)
            ? value.pluginUiProjection?.installedPackagesById[providerPluginId]?.displayName ?? null : null;
    }, [providerPluginId, binding]));
    const accountId = source && binding ? input.executionOriginV1?.accountId ?? binding.scope.accountId : null;
    const owner = useApprovalPrincipalName(accountId ? { kind: 'account', id: accountId } : undefined, serverId);
    return source ? { providerPluginId: source.providerPluginId, providerName, ownerName: owner.name } : undefined;
}
