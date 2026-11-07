import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderDiscoveryCandidateV1 } from '@happier-dev/protocol/providers/detection/v1';

import { randomUUID } from '@/platform/randomUUID';
import type { ProviderSettingsTargetV1 } from '@/providers/hooks/targetMachine';
import { useProviderConnectionMutation } from '@/providers/hooks/useProviderConnectionMutation';
import type { ProviderConnectionRefreshScope } from '@/providers/hooks/useProviderConnections';
import { t } from '@/text';

import { newProviderRoute, providerCandidatePendingKey, providerConnectionDetailRoute, providerInstallationPendingKey } from './providerCollectionModel';

type ProviderFoundContinuation = Readonly<{
    mutation: ReturnType<typeof useProviderConnectionMutation>;
    selectionError: ProviderErrorV1 | null;
    connectDetectedCandidate: (candidate: ProviderDiscoveryCandidateV1) => ReturnType<ReturnType<typeof useProviderConnectionMutation>['run']>;
    startLocalInstallation: (installation: Readonly<{ contributionKey: string }>) => ReturnType<ReturnType<typeof useProviderConnectionMutation>['run']>;
}>;

/** The collection and Add picker share the existing exact-Machine enable/start/authoring continuation. */
export function useProviderFoundContinuation(input: Readonly<{
    target: ProviderSettingsTargetV1;
    refresh: (scope?: ProviderConnectionRefreshScope) => Promise<void>;
    navigate: (href: string) => void;
}>): ProviderFoundContinuation {
    const { machineId, resolveCurrentTarget, accountServerId: serverId, accountAddressAvailable } = input.target;
    const mutation = useProviderConnectionMutation({ resolveTarget: resolveCurrentTarget, serverId,
        initiatingLifetime: accountAddressAvailable ? undefined : null, refresh: input.refresh });
    const [selectionError, setSelectionError] = React.useState<ProviderErrorV1 | null>(null);
    const connectDetectedCandidate = async (candidate: ProviderDiscoveryCandidateV1) => {
        if (!machineId || !resolveCurrentTarget()) return null;
        setSelectionError(null);
        const candidateId = candidate.candidateId;
        if (!candidateId) {
            setSelectionError(createProviderErrorV1('provider_authorization_changed', {
                machineId,
                ...(candidate.connection.status === 'matched' ? { connectionId: candidate.connection.connectionId } : {}),
            }));
            return null;
        }
        const openAuthoringDraft = (displayName: string | null) => input.navigate(newProviderRoute(candidate.contributionKey, { candidateId, displayName }));
        if (candidate.connection.status === 'requires_named_connection') {
            openAuthoringDraft(t('settingsProviders.local.defaultConnectionName', { provider: candidate.providerName }));
            return null;
        }
        const connectionId = candidate.connection.status === 'matched' ? candidate.connection.connectionId : `pc_${randomUUID()}`;
        const result = await mutation.run({ action: 'enableDetected', machineId, connectionId, candidateId,
            displayName: null, savedSecretId: null }, providerCandidatePendingKey(candidate));
        if (result?.status === 'error' && result.error.code === 'provider_secret_missing') {
            if (candidate.connection.status === 'matched') input.navigate(providerConnectionDetailRoute(candidate.connection.connectionId));
            else openAuthoringDraft(null);
            mutation.clearError();
        }
        return result;
    };
    const startLocalInstallation = async (installation: Readonly<{ contributionKey: string }>) => {
        if (!machineId) return null;
        return await mutation.run({ action: 'startLocal', machineId, connectionId: `pc_${randomUUID()}`,
            contributionKey: installation.contributionKey }, providerInstallationPendingKey(installation.contributionKey));
    };
    return { mutation, selectionError, connectDetectedCandidate, startLocalInstallation };
}
