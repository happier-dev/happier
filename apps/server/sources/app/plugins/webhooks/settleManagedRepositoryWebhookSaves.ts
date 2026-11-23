import { readManagedGithubWebhookHomeUrlV1 } from '@happier-dev/protocol/automations/event-setup-result';

import { AutomationValidationError } from '@/app/automations/automationValidation';
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

type ManagedRepositoryWebhookMutation = Readonly<{ triggerId: string; managedGithubRepositoryId?: string }>;

export async function admitManagedRepositoryWebhookSaves(
    request: object, mutations: readonly ManagedRepositoryWebhookMutation[],
): Promise<string | null> {
    if (!mutations.some(item => item.managedGithubRepositoryId !== undefined)) return null;
    const publicBaseUrl = await readWebhookAddress(request);
    if (!publicBaseUrl) throw new AutomationValidationError('github_webhook_home_unreachable');
    return publicBaseUrl;
}

/** Runs after the Automation transaction has committed. Only the saved trigger can own the route. */
export async function settleManagedRepositoryWebhookSaves(params: Readonly<{
    publicBaseUrl: string | null;
    accountId: string;
    automation: Readonly<{ id: string; triggers: readonly Readonly<{ id: string; revision: number }>[] }>;
    mutations: readonly ManagedRepositoryWebhookMutation[];
    forward: ForwardManagedPluginWebhookOperation;
}>) {
    const { publicBaseUrl } = params;
    if (publicBaseUrl === null) return undefined;
    const requested = params.mutations.flatMap(item => {
        if (item.managedGithubRepositoryId === undefined) return [];
        const trigger = params.automation.triggers.find(trigger => trigger.id === item.triggerId);
        return trigger ? [{ trigger, repositoryId: item.managedGithubRepositoryId }] : [];
    });
    if (!requested.length) return undefined;
    return await Promise.all(requested.map(async ({ trigger, repositoryId }) => {
        const result = await registerManagedPluginWebhookForEndpoint({
            accountId: params.accountId, automationId: params.automation.id,
            triggerId: trigger.id, triggerRevision: trigger.revision, repositoryId, publicBaseUrl,
            forward: params.forward,
        });
        return { triggerId: trigger.id, result };
    }));
}
