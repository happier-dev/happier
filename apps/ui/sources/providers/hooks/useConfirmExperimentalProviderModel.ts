import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol';

import { Modal } from '@/modal';
import type {
    SessionModelPickerExperimentalConfirmation,
    SessionModelPickerExperimentalConfirmationController,
} from '@/components/sessions/modelPicker/SessionModelPicker';
import { mutateProviderModelSettings, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import { providerErrorRequestsRetry } from '@/providers/connection/recovery';
import { t } from '@/text';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

export function useConfirmExperimentalProviderModel(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    agentTargetKey: string | null;
    refresh: () => Promise<unknown>;
}>): SessionModelPickerExperimentalConfirmationController {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const scopeKey = JSON.stringify([
        input.enabled,
        input.machineId,
        input.serverId,
        input.agentTargetKey,
    ]);
    const activeScopeKey = React.useRef(scopeKey);
    const activeAccountLifetime = React.useRef(accountLifetime);
    const mounted = React.useRef(false);
    const pendingAttemptId = React.useRef(0);
    const [pending, setPending] = React.useState(false);
    const [failure, setFailure] = React.useState<
        | Readonly<{
            error: ProviderErrorV1;
            retryAttempt: Readonly<{
                confirmation: SessionModelPickerExperimentalConfirmation;
                commitSelection: () => void;
            }>;
        }>
        | Readonly<{
            error: ProviderErrorV1;
            retryAttempt?: undefined;
        }>
        | null
    >(null);
    activeScopeKey.current = scopeKey;
    activeAccountLifetime.current = accountLifetime;
    React.useEffect(() => {
        mounted.current = true;
        pendingAttemptId.current += 1;
        setPending(false);
        setFailure(null);
        const registration = accountLifetime?.onRetire(() => {
            pendingAttemptId.current += 1;
            setPending(false);
            setFailure(null);
        });
        return () => {
            mounted.current = false;
            registration?.dispose();
        };
    }, [accountLifetime, scopeKey]);

    const persist = React.useCallback(async (
        confirmation: SessionModelPickerExperimentalConfirmation,
        commitSelection: () => void,
    ): Promise<boolean> => {
        if (
            !input.enabled
            || !input.machineId
            || !input.agentTargetKey
            || confirmation.agentTargetKey !== input.agentTargetKey
        ) return false;
        const requestScopeKey = scopeKey;
        const requestAccountLifetime = accountLifetime;
        const isCurrentScope = () => (
            mounted.current
            && activeScopeKey.current === requestScopeKey
            && activeAccountLifetime.current === requestAccountLifetime
            && (requestAccountLifetime?.isCurrent() ?? true)
        );
        if (!isCurrentScope()) return false;
        let result: Awaited<ReturnType<typeof mutateProviderModelSettings>>;
        try {
            result = await mutateProviderModelSettings({
                serverId: input.serverId,
                request: {
                    action: 'confirmExperimental',
                    machineId: input.machineId,
                    connectionId: confirmation.connectionId,
                    expectedConnectionRevision: confirmation.expectedConnectionRevision,
                    agentTargetKey: confirmation.agentTargetKey,
                    modelId: confirmation.modelId,
                    compatibilityFingerprint: confirmation.compatibilityFingerprint,
                },
            });
        } catch (caught) {
            if (!isCurrentScope()) return false;
            const error = providerErrorFromRpcFailure(caught, {
                connectionId: confirmation.connectionId,
                machineId: input.machineId,
            });
            if (error.code === 'provider_rpc_mutation_outcome_unknown') {
                try {
                    await input.refresh();
                } catch {
                    // The attempted confirmation may already be committed. Keep
                    // review-only recovery even when reconciliation cannot load.
                }
                if (!isCurrentScope()) return false;
            }
            setFailure(providerErrorRequestsRetry(error)
                ? { error, retryAttempt: { confirmation, commitSelection } }
                : { error });
            return false;
        }
        if (!isCurrentScope()) return false;
        if (result.status === 'error') {
            setFailure(providerErrorRequestsRetry(result.error)
                ? { error: result.error, retryAttempt: { confirmation, commitSelection } }
                : { error: result.error });
            return false;
        }
        setFailure(null);
        try {
            await input.refresh();
        } catch {
            // The daemon already committed the confirmation. A stale presentation
            // must not invite a duplicate mutation or block the requested selection.
        }
        if (!isCurrentScope()) return false;
        commitSelection();
        return true;
    }, [accountLifetime, input.agentTargetKey, input.enabled, input.machineId, input.refresh, input.serverId, scopeKey]);

    const runPending = React.useCallback(async (operation: () => Promise<boolean>): Promise<boolean> => {
        const attemptId = pendingAttemptId.current + 1;
        pendingAttemptId.current = attemptId;
        setPending(true);
        try {
            return await operation();
        } finally {
            if (pendingAttemptId.current === attemptId) {
                setPending(false);
            }
        }
    }, []);

    const confirm = React.useCallback(async (
        confirmation: SessionModelPickerExperimentalConfirmation,
        commitSelection: () => void,
    ): Promise<boolean> => {
        if (!input.enabled || !input.agentTargetKey || confirmation.agentTargetKey !== input.agentTargetKey) return false;
        return await runPending(async () => {
            setFailure(null);
            const confirmed = await Modal.confirm(
                t('settingsProviders.models.experimentalConfirmTitle'),
                t('settingsProviders.models.experimentalConfirmBody', {
                    provider: confirmation.providerName,
                    model: confirmation.modelName,
                }),
                { confirmText: t('settingsProviders.models.experimentalConfirmAction') },
            );
            if (
                !confirmed
                || activeScopeKey.current !== scopeKey
                || activeAccountLifetime.current !== accountLifetime
                || !(accountLifetime?.isCurrent() ?? true)
            ) return false;
            return await persist(confirmation, commitSelection);
        });
    }, [accountLifetime, input.agentTargetKey, input.enabled, persist, runPending, scopeKey]);
    const retry = React.useCallback(async (): Promise<boolean> => {
        if (!input.enabled || !failure?.retryAttempt) return false;
        return await runPending(() => persist(
            failure.retryAttempt.confirmation,
            failure.retryAttempt.commitSelection,
        ));
    }, [failure, input.enabled, persist, runPending]);
    const clear = React.useCallback(() => setFailure(null), []);

    return React.useMemo(() => ({
        confirm,
        pending: input.enabled && pending,
        error: input.enabled ? failure?.error ?? null : null,
        retry: input.enabled && failure?.retryAttempt ? retry : null,
        clear,
    }), [clear, confirm, failure, input.enabled, pending, retry]);
}
