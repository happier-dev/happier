import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { RunnerActivationCreateRequestV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { createRunnerActivationClient, RunnerActivationClientError } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Feature policy admits new activations; existing activations keep their read and cancel transport. */
export function createUiEphemeralRunnerAction(account: LazyActionAccountContext | undefined): NonNullable<ActionExecutorDeps['ephemeralRunnerAction']> {
    return async ({ actionId, input, signal }) => {
        if (!account) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        account.assertCurrent();
        if (actionId === 'sessions.runner.activation.create') {
            const snapshot = await getServerFeaturesSnapshot({ serverId: account.serverId });
            const settings = account.readLiveSettings() ?? account.settings;
            if (resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'sessions.ephemeralRunner', settings, snapshot })?.state !== 'enabled') {
                return { ok: false, errorCode: 'runner_unavailable', error: 'runner_unavailable' };
            }
        }
        const client = createRunnerActivationClient(account.request);
        try {
            if (actionId === 'sessions.runner.activation.create') {
                return await client.create(input as RunnerActivationCreateRequestV1);
            }
            const { activationId } = input as Readonly<{ activationId: string }>;
            if (actionId === 'sessions.runner.activation.get') return await client.read(activationId, signal);
            await client.cancel(activationId);
            return { activationId, closed: true };
        } catch (error) {
            if (error instanceof RunnerActivationClientError) {
                return { ok: false, errorCode: error.serverCode ?? error.code, error: error.message };
            }
            throw error;
        }
    };
}
