import {
    PluginAccountDataEraseActionInputV1Schema,
    type PluginAccountDataEraseActionInputV1,
    type PluginAccountDataEraseActionOutputV1,
    type PluginAccountDataEraseDataArmResultV1,
    type PluginAccountDataEraseSettingsArmResultV1,
} from '@happier-dev/protocol';

import {
    eraseCurrentAccountPluginData,
    type EraseCurrentAccountPluginDataOptionsV1,
} from '@/sync/api/plugins/data/eraseCurrentAccountPluginData';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

import {
    resolveScopedPluginSettingsTarget,
    type ScopedPluginSettingsAccountTarget,
} from './scopedPluginSettingsAdapter';
import {
    eraseCurrentAccountPluginSecretBindings,
    resolveScopedPluginSettingsServerIdentity,
} from './scopedPluginSettingsRuntime';
import type { AccountPluginSecretSettingsEraseResult } from './scopedPluginAccountSecretSettingsAdapter';

export type AccountPluginDataEraseActionDependencies = Readonly<{
    captureActiveAccountScopeLifetime(): ActiveServerAccountScopeLifetime | null;
    resolveAccountSettingsServerIdentity(serverId: string): string | null;
    resolveAccountSettingsTarget(serverIdentityId: string): ScopedPluginSettingsAccountTarget | null;
    eraseSettings(input: Readonly<{
        pluginId: string;
        target: ScopedPluginSettingsAccountTarget;
    }>): Promise<AccountPluginSecretSettingsEraseResult>;
    eraseData(
        input: PluginAccountDataEraseActionInputV1,
        options?: EraseCurrentAccountPluginDataOptionsV1,
    ): Promise<PluginAccountDataEraseDataArmResultV1>;
}>;

export type AccountPluginDataEraseAction = Readonly<{
    execute(
        input: PluginAccountDataEraseActionInputV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginAccountDataEraseActionOutputV1>;
}>;

function pendingSettingsUnavailable(): PluginAccountDataEraseSettingsArmResultV1 {
    return { status: 'pending', reason: 'unavailable' };
}

function pendingDataUnavailable(): PluginAccountDataEraseDataArmResultV1 {
    return { status: 'pending', reason: 'unavailable' };
}

function unavailableOutput(): PluginAccountDataEraseActionOutputV1 {
    return {
        status: 'partial',
        settings: pendingSettingsUnavailable(),
        data: pendingDataUnavailable(),
    };
}

function outputForArms(params: Readonly<{
    settings: PluginAccountDataEraseSettingsArmResultV1;
    data: PluginAccountDataEraseDataArmResultV1;
}>): PluginAccountDataEraseActionOutputV1 {
    const status = params.settings.status === 'completed' && params.data.status === 'completed'
        ? 'completed'
        : params.settings.status === 'failed' && params.data.status === 'failed'
            ? 'failed'
            : 'partial';
    return { status, settings: params.settings, data: params.data };
}

function mapSettingsResult(
    result: AccountPluginSecretSettingsEraseResult,
): PluginAccountDataEraseSettingsArmResultV1 {
    if (result.status === 'completed') return result;
    return result.status === 'conflict'
        ? { status: 'pending', reason: 'conflict' }
        : pendingSettingsUnavailable();
}

function failedSettingsUnexpected(): PluginAccountDataEraseSettingsArmResultV1 {
    return { status: 'failed', reason: 'unexpected' };
}

function resolveDefaultAccountSettingsTarget(
    serverIdentityId: string,
): ScopedPluginSettingsAccountTarget | null {
    const target = resolveScopedPluginSettingsTarget({
        scope: { kind: 'account' },
        serverIdentityId,
    });
    return target?.kind === 'account' ? target : null;
}

const defaultDependencies: AccountPluginDataEraseActionDependencies = Object.freeze({
    captureActiveAccountScopeLifetime: captureActiveServerAccountScopeLifetime,
    resolveAccountSettingsServerIdentity: resolveScopedPluginSettingsServerIdentity,
    resolveAccountSettingsTarget: resolveDefaultAccountSettingsTarget,
    eraseSettings: eraseCurrentAccountPluginSecretBindings,
    eraseData: eraseCurrentAccountPluginData,
});

/**
 * Coordinates only the two incumbent Account erase arms behind the canonical
 * Action dependency. Both owners are idempotent, so every retry revisits both
 * destinations instead of caching a completion fact that later writes could
 * invalidate. The captured Account lifetime prevents cross-Account settlement.
 */
export function createAccountPluginDataEraseAction(
    dependencies: AccountPluginDataEraseActionDependencies = defaultDependencies,
): AccountPluginDataEraseAction {
    const isCurrent = (lifetime: ActiveServerAccountScopeLifetime, signal: AbortSignal): boolean => (
        lifetime.isCurrent() && !signal.aborted
    );

    return Object.freeze({
        async execute(input, options): Promise<PluginAccountDataEraseActionOutputV1> {
            const request = PluginAccountDataEraseActionInputV1Schema.parse(input);
            if (options?.signal?.aborted) return unavailableOutput();

            const lifetime = dependencies.captureActiveAccountScopeLifetime();
            if (!lifetime || !lifetime.isCurrent()) return unavailableOutput();

            const controller = new AbortController();
            const abort = () => controller.abort();
            const retirement = lifetime.onRetire(abort);
            options?.signal?.addEventListener('abort', abort, { once: true });
            if (options?.signal?.aborted) abort();

            try {
                if (!isCurrent(lifetime, controller.signal)) return unavailableOutput();
                const serverIdentityId = dependencies.resolveAccountSettingsServerIdentity(lifetime.scope.serverId);
                const target = serverIdentityId
                    ? dependencies.resolveAccountSettingsTarget(serverIdentityId)
                    : null;

                let settings = pendingSettingsUnavailable();
                if (target) {
                    if (!isCurrent(lifetime, controller.signal)) return unavailableOutput();
                    try {
                        settings = mapSettingsResult(await dependencies.eraseSettings({
                            pluginId: request.pluginId,
                            target,
                        }));
                    } catch {
                        settings = failedSettingsUnexpected();
                    }
                    if (!isCurrent(lifetime, controller.signal)) return unavailableOutput();
                }

                if (!isCurrent(lifetime, controller.signal)) return unavailableOutput();
                let data = pendingDataUnavailable();
                try {
                    data = await dependencies.eraseData(request, { signal: controller.signal });
                } catch {
                    data = pendingDataUnavailable();
                }
                if (!isCurrent(lifetime, controller.signal)) return unavailableOutput();

                return outputForArms({ settings, data });
            } finally {
                options?.signal?.removeEventListener('abort', abort);
                retirement.dispose();
            }
        },
    });
}

/** The default Action dependency captures the active Account for each invocation. */
const defaultAction = createAccountPluginDataEraseAction();

export async function executeAccountPluginDataEraseAction(
    input: PluginAccountDataEraseActionInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginAccountDataEraseActionOutputV1> {
    return await defaultAction.execute(input, options);
}
