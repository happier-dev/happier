import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';
import { projectAccountProviderConnectionModelsV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import { PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { OLLAMA_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/ollama/src/provider/contribution';
import { isFileEditorAiSuggestionModel } from '@/providers/models/fileEditorAiSuggestionModel';

// Only the external Socket/Account HTTP boundaries are substituted. Catalog,
// Action approval, revision/CAS, projection and mutation hooks remain real.
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const account = createProviderSettingsAccountHarness();
const { useProviderModelGenerationSettings } = await import('./useProviderModelGenerationSettings');
const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
const { useProviderCatalogForServer } = await import('@/sync/store/useProviderCatalog');
const modelId = 'qwen2.5-coder:1.5b-base';
const connectionId = 'pc_ollama';
const resolveTarget = () => null;
const refresh = async () => {};
let serverId = '';

function persistedCatalog() {
    const content = account.readCatalogRow()?.content;
    if (content?.t !== 'plain') throw new Error('Expected a Plain Account catalog');
    return ProviderConnectionsCatalogV1Schema.parse(content.v);
}

async function renderGenerationSettings() {
    const hook = await renderHook(() => {
        const catalog = useProviderCatalogForServer(serverId);
        const connection = catalog?.data?.connections.find(row => row.id === connectionId) ?? null;
        return { ...useProviderModelGenerationSettings({ connection, modelId, resolveTarget, serverId, refresh }),
            ready: useProviderActionClient(serverId).ready && connection !== null };
    });
    await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
    return hook;
}

beforeAll(loadSyncSingletonForTests);
describe('Provider model generation settings', () => {
    beforeEach(async () => {
        providerHarness.reset();
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: connectionId,
                source: { kind: 'contribution', contributionKey: 'happier.provider.ollama/ollama' },
                role: 'named', displayName: 'Local models', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
                modelSettings: { [modelId]: { temperature: 0.2 }, other: { maxTokens: 32 } } }],
        });
        serverId = (await account.restore({ catalog,
            waivedActions: Object.values(PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1) })).serverId;
    });
    afterEach(async () => { await standardCleanup(); await account.reset(); });

    it('carries a designed allowance Confirm through Save and Clear without another prompt', async () => {
        const catalog = persistedCatalog();
        await account.reset();
        serverId = (await account.restore({ catalog, waivedActions: [] })).serverId;
        const hook = await renderGenerationSettings();
        const { Modal } = await import('@/modal');
        const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
        await act(async () => { expect(await hook.getCurrent().save(128, { confirmed: true })).toMatchObject({ status: 'success' }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().value).toBe(128));
        await act(async () => { expect(await hook.getCurrent().clear({ confirmed: true })).toMatchObject({ status: 'success' }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().value).toBeNull());
        expect(account.catalogMutations).toHaveLength(2);
        expect(confirm).not.toHaveBeenCalled();
        expect(account.home.artifacts(serverId).list()).toEqual([]);
    });

    it('saves and clears an Ollama allowance through the Account Action without a Machine, preserving other preferences', async () => {
        const offered = () => {
            const catalog = persistedCatalog();
            return projectAccountProviderConnectionModelsV1({ source: ProviderContributionV1Schema.parse(OLLAMA_PROVIDER_CONTRIBUTION),
                connection: catalog.connections[0]!, catalog })
                .filter(row => row.descriptor && isFileEditorAiSuggestionModel(row.descriptor)).map(row => row.id);
        };
        const hook = await renderGenerationSettings();
        expect(hook.getCurrent().value).toBeNull();
        expect(offered()).not.toContain(modelId);
        expect(account.catalogMutations).toHaveLength(0);
        await act(async () => { expect(await hook.getCurrent().save(128)).toMatchObject({ status: 'success' }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().value).toBe(128));
        expect(offered()).toContain(modelId);
        expect(persistedCatalog().connections[0]?.modelSettings).toEqual({
            [modelId]: { temperature: 0.2, maxTokens: 128 }, other: { maxTokens: 32 },
        });
        await act(async () => { expect(await hook.getCurrent().clear()).toMatchObject({ status: 'success' }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().value).toBeNull());
        expect(offered()).not.toContain(modelId);
        expect(persistedCatalog().connections[0]?.modelSettings).toEqual({
            [modelId]: { temperature: 0.2, maxTokens: null }, other: { maxTokens: 32 },
        });
        expect(account.catalogMutations).toHaveLength(2);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('refuses a nonpositive or fractional allowance before any Account write', async () => {
        const hook = await renderGenerationSettings();
        for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => hook.getCurrent().save(value)).toThrow(RangeError);
        }
        expect(account.catalogMutations).toHaveLength(0);
        expect(hook.getCurrent().value).toBeNull();
    });
});
