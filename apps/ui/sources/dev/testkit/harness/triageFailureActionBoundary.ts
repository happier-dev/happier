import { onTestFinished } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginClientActionContext } from '@happier-dev/plugin-sdk/actions';
import { createPluginClientTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';
import { activate } from '@happier-dev/plugins-triage/happier-plugin-ui/triage-mounted-ui-action-native';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { getPluginUiEphemeralSharedScope } from '@/components/plugins/surfaces/pluginUiEphemeralSharedScope';
import { createActionExecutorBoundaryFixture } from '../fixtures/actionExecutorBoundary';

export const TRIAGE_FAILURE_TEST_BINDING = { pluginId: PLUGIN_MANIFEST.id, action: 'native-failure/handle-v1' };

/** Keep the declared client Action and its retained owner real beneath the realm transport. */
export function createTriageFailureActionBoundaryFixture(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
    const boundary = createActionExecutorBoundaryFixture(overrides);
    if (!overrides.invokeContributedAction) return boundary;
    const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === TRIAGE_FAILURE_TEST_BINDING.action);
    if (declaration?.execution.target !== 'client') throw new Error('Missing native failure client Action');
    const client = createPluginClientTestkit({ manifest: PLUGIN_MANIFEST,
        target: { ...declaration.execution.client, platform: 'web' }, activate });
    let current = true;
    const retire = new Set<() => void>();
    const accountLifetime = {
        scope: { serverId: 'server-a', accountId: `failure-test-${crypto.randomUUID()}` },
        isCurrent: () => current,
        onRetire(listener: () => void) { retire.add(listener); return { dispose: () => { retire.delete(listener); } }; },
    };
    const shared = getPluginUiEphemeralSharedScope({ accountLifetime, pluginId: PLUGIN_MANIFEST.id,
        occurrenceId: 'client-action', pluginGenerationId: 'test-generation',
        artifactDigest: `sha256:${'a'.repeat(64)}`, isCurrent: () => current });
    onTestFinished(async () => {
        current = false;
        for (const listener of retire) listener();
        await (await client).dispose();
    });
    return { ...boundary, invokeContributedAction: async request => {
        if (request.action.localId !== TRIAGE_FAILURE_TEST_BINDING.action) {
            if (!boundary.invokeContributedAction) throw new Error('Unexpected contributed Action');
            return boundary.invokeContributedAction(request);
        }
        const handler = (await client).registration('actions', declaration.id);
        if (!handler) throw new Error('Native failure client Action was not registered');
        // This fixture installs only the external UI/Action transport ports used by native failures.
        const context = { plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
            signal: request.signal ?? new AbortController().signal, ephemeralSharedScope: shared,
            ui: { context: async () => ({ accountScope: { serverId: request.context.serverId, accountId: request.context.expectedAccountId } }),
                executeAction: async (_actionId: string, payload: Readonly<{ action: typeof request.action; input: unknown }>) => {
                    if (!boundary.invokeContributedAction) throw new Error('Unexpected contributed Action');
                    const answer = await boundary.invokeContributedAction({ ...request, action: payload.action, input: payload.input });
                    if (!answer.ok) throw new PluginError({ code: answer.errorCode ?? 'action_failed', message: answer.error,
                        details: { effectAttempted: answer.effectAttempted === true } });
                    return answer.result;
                },
            },
        } as unknown as PluginClientActionContext;
        return { ok: true, result: await handler(request.input, context) };
    } };
}
