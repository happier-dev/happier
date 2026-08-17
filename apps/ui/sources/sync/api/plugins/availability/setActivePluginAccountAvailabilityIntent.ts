import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentSetActionInputV1Schema,
    PluginAvailabilityIntentSetActionOutputV1Schema,
    type PluginAvailabilityIntentSetActionInputV1,
    type PluginAvailabilityIntentSetActionOutputV1,
} from '@happier-dev/protocol/plugins/availability';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureSessionRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';

type AvailabilityIntentSetServerSnapshot = Readonly<{
    serverId: string | null;
    generation: number;
}>;

type AvailabilityIntentSetRequestAuthority = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
}>;

export type ActivePluginAccountAvailabilityIntentSetterDependencies = Readonly<{
    captureLifetime: () => ActiveServerAccountScopeLifetime | null;
    getServerSnapshot: () => AvailabilityIntentSetServerSnapshot;
    captureRequestAuthority: (scope: ServerAccountScope) => Promise<AvailabilityIntentSetRequestAuthority>;
}>;

export type ActivePluginAccountAvailabilityIntentSetResult =
    | Readonly<{
        kind: 'updated';
        intent: PluginAvailabilityIntentSetActionOutputV1['intent'];
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'account_scope_changed' | 'server_generation_changed' | 'transport_unavailable' | 'response_invalid';
    }>
    | Readonly<{ kind: 'conflict'; code: 'intent_revision_conflict' }>
    | Readonly<{ kind: 'preparationRequired' }>
    | Readonly<{ kind: 'rejected'; code: 'request_rejected' }>;

function defaultDependencies(): ActivePluginAccountAvailabilityIntentSetterDependencies {
    return {
        captureLifetime: captureActiveServerAccountScopeLifetime,
        getServerSnapshot: () => {
            const snapshot = getActiveServerSnapshot();
            return { serverId: snapshot.serverId, generation: snapshot.generation };
        },
        captureRequestAuthority: async (scope) => {
            const authority = await captureSessionRequestAuthorityForServerAccountScope({
                scope,
                activeRequest: (path, init) => apiSocket.request(path, init),
            });
            return Object.freeze({ request: authority.request });
        },
    };
}

function isCurrent(input: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    snapshot: AvailabilityIntentSetServerSnapshot;
    getServerSnapshot: () => AvailabilityIntentSetServerSnapshot;
}>): Extract<ActivePluginAccountAvailabilityIntentSetResult, { kind: 'unavailable' }>['code'] | null {
    if (!input.lifetime.isCurrent()) return 'account_scope_changed';
    const current = input.getServerSnapshot();
    if (current.serverId !== input.snapshot.serverId || current.generation !== input.snapshot.generation) {
        return 'server_generation_changed';
    }
    return null;
}

function responseMatchesRequest(input: Readonly<{
    response: PluginAvailabilityIntentSetActionOutputV1;
    request: PluginAvailabilityIntentSetActionInputV1;
}>): boolean {
    const { intent } = input.response;
    return intent.pluginId === input.request.pluginId
        && intent.desiredVersion === input.request.desiredVersion
        && intent.enabled === input.request.enabled
        && intent.offlineUiHosting === input.request.offlineUiHosting
        && JSON.stringify(intent.writableCollections) === JSON.stringify(input.request.writableCollections);
}

function isIntentRevisionConflictResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Readonly<Record<string, unknown>>;
    return Object.keys(record).length === 1
        && record.error === 'plugin_intent_revision_conflict';
}

function isWritableCollectionsPreparationRequiredResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Readonly<Record<string, unknown>>;
    return Object.keys(record).length === 1
        && record.error === 'plugin_intent_writable_collections_not_ready';
}

/**
 * The one direct-UI Account Availability intent-CAS transport. It captures the
 * active Account lifetime and server generation, but deliberately accepts no
 * Account id from the caller and does not own candidate/data readiness.
 */
export function createActivePluginAccountAvailabilityIntentSetter(
    overrides: Partial<ActivePluginAccountAvailabilityIntentSetterDependencies> = {},
): Readonly<{
    set: (input: PluginAvailabilityIntentSetActionInputV1) => Promise<ActivePluginAccountAvailabilityIntentSetResult>;
}> {
    const dependencies: ActivePluginAccountAvailabilityIntentSetterDependencies = {
        ...defaultDependencies(),
        ...overrides,
    };
    return Object.freeze({
        set: async (input) => {
            const parsed = PluginAvailabilityIntentSetActionInputV1Schema.safeParse(input);
            if (!parsed.success) return Object.freeze({ kind: 'unavailable', code: 'response_invalid' });
            const lifetime = dependencies.captureLifetime();
            if (!lifetime?.isCurrent()) {
                return Object.freeze({ kind: 'unavailable', code: 'account_scope_changed' });
            }
            const snapshot = dependencies.getServerSnapshot();
            if (snapshot.serverId !== lifetime.scope.serverId) {
                return Object.freeze({ kind: 'unavailable', code: 'server_generation_changed' });
            }
            const controller = new AbortController();
            const retirement = lifetime.onRetire(() => controller.abort());
            try {
                const beforeAuthority = isCurrent({
                    lifetime,
                    snapshot,
                    getServerSnapshot: dependencies.getServerSnapshot,
                });
                if (beforeAuthority || controller.signal.aborted) {
                    return Object.freeze({ kind: 'unavailable', code: beforeAuthority ?? 'account_scope_changed' });
                }
                const authority = await dependencies.captureRequestAuthority(lifetime.scope);
                const afterAuthority = isCurrent({
                    lifetime,
                    snapshot,
                    getServerSnapshot: dependencies.getServerSnapshot,
                });
                if (afterAuthority || controller.signal.aborted) {
                    return Object.freeze({ kind: 'unavailable', code: afterAuthority ?? 'account_scope_changed' });
                }
                let response: Response;
                try {
                    response = await authority.request(
                        PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.set'],
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(parsed.data),
                            signal: controller.signal,
                        },
                    );
                } catch {
                    return Object.freeze({ kind: 'unavailable', code: 'transport_unavailable' });
                }
                const afterResponse = isCurrent({
                    lifetime,
                    snapshot,
                    getServerSnapshot: dependencies.getServerSnapshot,
                });
                if (afterResponse || controller.signal.aborted) {
                    return Object.freeze({ kind: 'unavailable', code: afterResponse ?? 'account_scope_changed' });
                }
                if (!response.ok) {
                    const raw = await response.json().catch(() => null);
                    const afterBody = isCurrent({
                        lifetime,
                        snapshot,
                        getServerSnapshot: dependencies.getServerSnapshot,
                    });
                    if (afterBody || controller.signal.aborted) {
                        return Object.freeze({ kind: 'unavailable', code: afterBody ?? 'account_scope_changed' });
                    }
                    if (response.status === 409 && isIntentRevisionConflictResponse(raw)) {
                        return Object.freeze({ kind: 'conflict' as const, code: 'intent_revision_conflict' as const });
                    }
                    if (response.status === 400 && isWritableCollectionsPreparationRequiredResponse(raw)) {
                        return Object.freeze({ kind: 'preparationRequired' as const });
                    }
                    return response.status >= 500 || response.status === 404
                        ? Object.freeze({ kind: 'unavailable' as const, code: 'transport_unavailable' as const })
                        : Object.freeze({ kind: 'rejected' as const, code: 'request_rejected' as const });
                }
                const raw = await response.json().catch(() => null);
                const afterBody = isCurrent({
                    lifetime,
                    snapshot,
                    getServerSnapshot: dependencies.getServerSnapshot,
                });
                if (afterBody || controller.signal.aborted) {
                    return Object.freeze({ kind: 'unavailable', code: afterBody ?? 'account_scope_changed' });
                }
                const output = PluginAvailabilityIntentSetActionOutputV1Schema.safeParse(raw);
                if (!output.success || !responseMatchesRequest({ response: output.data, request: parsed.data })) {
                    return Object.freeze({ kind: 'unavailable', code: 'response_invalid' });
                }
                return Object.freeze({ kind: 'updated', intent: output.data.intent });
            } finally {
                retirement.dispose();
            }
        },
    });
}

const installedActivePluginAccountAvailabilityIntentSetter =
    createActivePluginAccountAvailabilityIntentSetter();

export async function setActivePluginAccountAvailabilityIntent(
    input: PluginAvailabilityIntentSetActionInputV1,
): Promise<ActivePluginAccountAvailabilityIntentSetResult> {
    return await installedActivePluginAccountAvailabilityIntentSetter.set(input);
}
