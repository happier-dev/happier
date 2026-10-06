import { switchConnectionToActiveServer } from '../../runtime/orchestration/connectionManager';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';
import { guardAccountEncryptionFirstKeyCredentialMutation } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from './serverRuntime';
import {
    adoptHomeProfile,
    areServerProfileIdentifiersEquivalent,
    clearTabActiveServerId,
    defaultHomeNameForAddress,
    getDeviceDefaultServerId,
    getServerProfileById,
    getTabActiveServerId,
} from './serverProfiles';
import type { ServerProfileSource } from './serverProfiles';
import { canonicalizeServerUrl, createServerUrlComparableKey } from './url/serverUrlCanonical';

export { upsertAndActivateServer } from './serverRuntime';
export { defaultHomeNameForAddress as defaultServerNameFromUrl } from './serverProfiles';

export type ActiveServerSwitchResult = 'switched' | 'already_active' | 'blocked';

let activeServerSwitchTail: Promise<void> = Promise.resolve();

async function serializeActiveServerSwitch<T>(run: () => Promise<T>): Promise<T> {
    const previous = activeServerSwitchTail;
    let release!: () => void;
    activeServerSwitchTail = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await run();
    } finally {
        release();
    }
}

export function normalizeServerUrl(raw: string): string {
    return canonicalizeServerUrl(raw);
}

export function isSameServerUrl(left: string, right: string): boolean {
    const leftKey = createServerUrlComparableKey(left);
    if (!leftKey) return false;
    return leftKey === createServerUrlComparableKey(right);
}

async function presentRetainedTargetCustody(): Promise<void> {
    const target = getActiveServerSnapshot();
    await presentFirstKeyCredentialLifecycle({
        run: async () => {
            const guard =
                await guardAccountEncryptionFirstKeyCredentialMutation({
                    serverUrl: target.serverUrl,
                    serverId: target.serverId,
                });
            return guard.kind === 'allowed'
                ? { kind: 'completed' }
                : guard;
        },
    });
}

/**
 * A focus change is not a credential mutation: it neither removes nor replaces any
 * Home's credentials, so retained first-key custody on one Home (PA-CUSTODY1 guards
 * destructive transitions of the Home that holds it) cannot block focusing another
 * Home. The custody stays byte-preserved on its own Home and is presented, through
 * the same shared lifecycle, when that exact Home is entered.
 */
async function runGuardedActiveServerSwitch(
    run: () => Promise<void>,
): Promise<Exclude<ActiveServerSwitchResult, 'already_active'>> {
    await run();
    await presentRetainedTargetCustody();
    return 'switched';
}

function canSkipActiveServerUrlSwitch(params: Readonly<{
    activeServerUrl: string;
    targetServerUrl: string;
    scope: 'device' | 'tab';
}>): boolean {
    if (!isSameServerUrl(params.activeServerUrl, params.targetServerUrl)) return false;
    if (params.scope === 'tab') return true;
    return !getTabActiveServerId();
}

function canSkipActiveServerIdSwitch(params: Readonly<{
    activeServerId: string;
    targetServerId: string;
    scope: 'device' | 'tab';
    requireExactProfile: boolean;
}>): boolean {
    if (params.requireExactProfile && params.activeServerId !== params.targetServerId) return false;
    if (!areServerProfileIdentifiersEquivalent(params.activeServerId, params.targetServerId)) return false;
    if (params.scope === 'tab') return true;
    return !getTabActiveServerId()
        && areServerProfileIdentifiersEquivalent(getDeviceDefaultServerId(), params.targetServerId);
}

async function stageActiveServerAndSwitch(
    stage: () => Promise<void>,
    refreshAuth?: () => Promise<void>,
): Promise<void> {
    const previousDeviceServerId = getDeviceDefaultServerId();
    const previousTabServerId = getTabActiveServerId();
    await stage();

    try {
        await switchConnectionToActiveServer();
        await refreshAuth?.();
    } catch (switchError) {
        try {
            await setActiveServer({ serverId: previousDeviceServerId, scope: 'device' });
            if (previousTabServerId) {
                await setActiveServer({ serverId: previousTabServerId, scope: 'tab' });
            } else {
                clearTabActiveServerId();
            }
            await switchConnectionToActiveServer();
        } catch (rollbackError) {
            throw new AggregateError(
                [switchError, rollbackError],
                'Active server switch failed and the previous connection could not be restored.',
            );
        }
        throw switchError;
    }
}

export async function upsertActivateAndSwitchServer(params: Readonly<{
    serverUrl: string;
    source?: ServerProfileSource;
    scope?: 'device' | 'tab';
    name?: string;
    refreshAuth?: (() => Promise<void>) | null;
}>): Promise<ActiveServerSwitchResult> {
    return await serializeActiveServerSwitch(async () => {
        const targetServerUrl = normalizeServerUrl(params.serverUrl);
        if (!targetServerUrl) return 'blocked';

        const active = getActiveServerSnapshot();
        const scope = params.scope ?? 'device';
        if (canSkipActiveServerUrlSwitch({ activeServerUrl: active.serverUrl, targetServerUrl, scope })) {
            // No connection change is needed, but choosing the seeded Home is
            // still explicit intent. Welcome must not treat it as a service fallback.
            if (active.isSelectionExplicit !== true) await setActiveServer({ serverId: active.serverId, scope });
            return 'already_active';
        }

        return await runGuardedActiveServerSwitch(async () => {
            const source = params.source ?? 'url';
            if (source === 'manual') {
                const profile = await adoptHomeProfile({
                    descriptor: { serverUrl: targetServerUrl },
                    source: 'manual',
                    preserveUserLabel: true,
                });
                await stageActiveServerAndSwitch(async () => {
                    await setActiveServer({ serverId: profile.id, scope });
                }, params.refreshAuth ?? undefined);
            } else {
                await stageActiveServerAndSwitch(async () => {
                    await upsertAndActivateServer({
                        serverUrl: targetServerUrl,
                        name: params.name ?? defaultHomeNameForAddress(targetServerUrl),
                        source,
                        scope,
                    });
                }, params.refreshAuth ?? undefined);
            }
        });
    });
}

export async function setActiveServerAndSwitch(params: Readonly<{
    serverId: string;
    scope?: 'device' | 'tab';
    refreshAuth?: (() => Promise<void>) | null;
    /** Reassert the requested saved profile even when its stable Home identity is already focused. */
    requireExactProfile?: boolean;
}>): Promise<ActiveServerSwitchResult> {
    return await serializeActiveServerSwitch(async () => {
        const targetServerId = String(params.serverId ?? '').trim();
        if (!targetServerId || !getServerProfileById(targetServerId)) return 'blocked';

        const active = getActiveServerSnapshot();
        const scope = params.scope ?? 'device';
        if (canSkipActiveServerIdSwitch({
            activeServerId: active.serverId,
            targetServerId,
            scope,
            requireExactProfile: params.requireExactProfile === true,
        })) {
            if (active.isSelectionExplicit !== true) await setActiveServer({ serverId: targetServerId, scope });
            return 'already_active';
        }

        return await runGuardedActiveServerSwitch(async () => {
            await stageActiveServerAndSwitch(async () => {
                await setActiveServer({
                    serverId: targetServerId,
                    scope,
                });
            }, params.refreshAuth ?? undefined);
        });
    });
}
