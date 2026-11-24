import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import {
    PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionOutputV1Schema,
    PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE, snapshotPluginReleaseFactsV1,
    type PluginAvailabilityIntentReadActionOutputV1,
} from '@happier-dev/protocol/plugins/availability';

export type AccountReadBinding = Readonly<{ credentials: StoredCredentials; serverUrl: string; signal?: AbortSignal }>;

export async function postAvailability(input: AccountReadBinding, path: string, body: unknown): Promise<unknown> {
    input.signal?.throwIfAborted();
    const response = await axios.post(`${input.serverUrl.replace(/\/+$/, '')}${path}`, body, {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}` },
        timeout: 0, ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    return response.data;
}

export function snapshotIntentRead(pluginId: string, response: PluginAvailabilityIntentReadActionOutputV1): PluginAvailabilityIntentReadActionOutputV1 {
    if ((response.intent && response.intent.pluginId !== pluginId)
        || (response.release && response.release.ref.pluginId !== pluginId)
        || response.uiArtifacts.some(link => link.release.pluginId !== pluginId)
        || response.packageAssets.some(link => link.release.pluginId !== pluginId)) {
        throw new Error('plugin_account_execution_identity_mismatch');
    }
    return Object.freeze({ ...response,
        release: response.release ? snapshotPluginReleaseFactsV1(response.release) : null,
    });
}

/** Exact named intent reads: one request per Availability page of the named set, never the Account census. */
export async function readNamedAccountPluginIntentReads(input: AccountReadBinding & Readonly<{ pluginIds: readonly string[] }>) {
    const pluginIds = [...new Set(input.pluginIds)].sort();
    const reads = new Map<string, PluginAvailabilityIntentReadActionOutputV1>();
    for (let start = 0; start < pluginIds.length; start += PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE) {
        const named = pluginIds.slice(start, start + PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE);
        assertIntentPage(input, PluginAvailabilityIntentsListActionOutputV1Schema.parse(await postAvailability(input,
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
                pluginIds: named,
                omitDeclarations: true,
            })), reads);
    }
    if (pluginIds.some(pluginId => !reads.has(pluginId))) throw new Error('plugin_account_execution_unavailable');
    return reads;
}

/** Admits one strict intent page into `reads`: a failed or duplicated read fails the whole read. */
export function assertIntentPage(input: Readonly<{ isCurrent?: () => boolean }>,
    page: ReturnType<typeof PluginAvailabilityIntentsListActionOutputV1Schema.parse>,
    reads: Map<string, PluginAvailabilityIntentReadActionOutputV1>): void {
    if (input.isCurrent?.() === false) throw new Error('plugin_account_execution_retired');
    if (page.failedPluginIds.length > 0) throw new Error('plugin_account_execution_unavailable');
    for (const entry of page.intentReads) {
        const response = snapshotIntentRead(entry.pluginId, entry.response);
        if (reads.has(entry.pluginId)) throw new Error('plugin_account_execution_duplicate_read');
        reads.set(entry.pluginId, response);
    }
}
