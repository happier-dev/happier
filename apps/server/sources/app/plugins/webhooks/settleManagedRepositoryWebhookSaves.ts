import { readManagedGithubWebhookHomeUrlV1 } from '@happier-dev/protocol/automations/event-setup-result';

import type { ForwardManagedPluginWebhookOperation } from '@/app/api/socket/managedPluginWebhookDispatcher';
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';
import { projectHomeIngressReachability } from '@/app/home/reachability/homeReachability';
import { resolveInferredPublicServerAccess } from '@/app/integrations/publicUrl/publicServerUrlInference';

import { registerManagedPluginWebhookForEndpoint } from './registerManagedPluginWebhookForEndpoint';

async function readWebhookAddress(request: object) {
    const access = await resolveInferredPublicServerAccess(await readRequestHomeEnv(request)).catch(() => null);
    const env = await readRequestHomeEnv(request, {
        inferred: access?.inferred ? { HAPPIER_PUBLIC_SERVER_URL: access.inferred.url } : {},
    });
    return readManagedGithubWebhookHomeUrlV1(projectHomeIngressReachability({ env, access }));
}

/** Runs after the Automation transaction has committed. Only the saved trigger can own the route. */
export async function settleManagedRepositoryWebhookSaves(params: Readonly<{
    request: object;
    accountId: string;
    automation: Readonly<{ id: string; triggers: readonly Readonly<{ id: string; revision: number }>[] }>;
    mutations: readonly Readonly<{ triggerId: string; managedGithubRepositoryId?: string }>[];
    forward: ForwardManagedPluginWebhookOperation;
}>) {
    const requested = params.mutations.flatMap(item => {
        if (item.managedGithubRepositoryId === undefined) return [];
        const trigger = params.automation.triggers.find(trigger => trigger.id === item.triggerId);
        return trigger ? [{ trigger, repositoryId: item.managedGithubRepositoryId }] : [];
    });
    if (!requested.length) return undefined;
    const publicBaseUrl = await readWebhookAddress(params.request).catch(() => null);
    return await Promise.all(requested.map(async ({ trigger, repositoryId }) => {
        const result = publicBaseUrl ? await registerManagedPluginWebhookForEndpoint({
            accountId: params.accountId, automationId: params.automation.id,
            triggerId: trigger.id, triggerRevision: trigger.revision, repositoryId, publicBaseUrl,
            forward: params.forward,
        }) : { kind: 'polling', code: 'route_unavailable' } as const;
        return { triggerId: trigger.id, result };
    }));
}
