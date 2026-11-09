import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1 } from '@happier-dev/protocol/account/settings/accountSettings';
import { projectProviderModelGenerationSettings, type ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import { DaemonProviderModelRowV1Schema, RPC_METHODS, type DaemonProviderModelRowV1 } from '@happier-dev/protocol/rpc';

import { createMachineFixture, flushHookEffects, renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const connectionId = ProviderConnectionIdSchema.parse('pc_ollama');
const routerPush = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: routerPush } }).module;
    },
    storage: 'real',
});

const { createProviderConnectionViewFixture, createProviderConnectionsDescribeFixture, createProviderModelsFixture, createProviderSettingsAccountHarness, createProviderSettingsHarness, installBundledProviderDeclarationsRpcBoundary, installProviderSettingsRpcBoundary, installProviderConnectionsCatalogHttpBoundary } = await import('@/dev/testkit/harness/providerSettingsHarness');
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const account = createProviderSettingsAccountHarness();
const machine = createMachineFixture({ id: 'machine-a', kind: 'persistent', activeAt: Date.now() });
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { FileEditorAiSuggestionSettings } = await import('./FileEditorAiSuggestionSettings');
const { SettingRow } = await import('@/components/settings/shell/SettingRow');
const { SOURCE_CONTROL_SETTINGS } = await import('./sourceControlSettings');
const { getStorage } = await import('@/sync/domains/state/storage');

// A local FIM model whose catalog declares the editor operation but, like a real Ollama tag, no output allowance.
const qwen: ProviderModelDescriptorV1 = {
    id: 'qwen2.5-coder:1.5b-base', name: 'Qwen2.5 Coder base', contextWindowTokens: 32768,
    inlineCompletion: { operationId: 'native-fim', tokenAccounting: 'utf8-bytes', promptOverheadTokens: 3 },
};
// A dedicated next-edit model: it declares only the next-edit operation, with its own output allowance.
const sweep: ProviderModelDescriptorV1 = {
    id: 'sweep-next-edit:1.5b', name: 'Sweep Next Edit', contextWindowTokens: 8192,
    nextEdit: { operationId: 'rewrite-window', tokenAccounting: 'utf8-bytes', outputTokens: 1024, promptOverheadTokens: 32 },
};
let savedAllowance: number | undefined;
let offerNextEditModel = false;
// The Account's saved ghost-text model, seeded on the Account itself so a settings write echoes it back.
let seededModelId: string | null = null;
function modelRows(): DaemonProviderModelRowV1[] {
    // The Machine lists the descriptor already specialised by the connection's saved allowance.
    const descriptor = projectProviderModelGenerationSettings(qwen, savedAllowance === undefined ? undefined : { maxTokens: savedAllowance });
    return [
        { id: qwen.id, name: qwen.name, source: 'static', stale: false, loadState: 'unknown', visibility: 'visible', descriptor },
        { id: 'llama3.2:3b', name: 'Llama 3.2', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible',
            descriptor: { id: 'llama3.2:3b', name: 'Llama 3.2', contextWindowTokens: 131072 } },
        ...(offerNextEditModel ? [{ id: sweep.id, name: sweep.name, source: 'static' as const, stale: false, loadState: 'unknown' as const,
            visibility: 'visible' as const, descriptor: sweep }] : []),
    ].map(row => DaemonProviderModelRowV1Schema.parse(row));
}
async function openModelPicker() {
    const screen = await renderScreen(<FileEditorAiSuggestionSettings machineId="machine-a" serverId={account.serverId} />);
    await flushHookEffects();
    const menus = screen.findAllByType(DropdownMenu);
    await act(async () => { menus[1]!.props.onOpenChange(true); });
    await act(async () => { await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)[1]!.props.items.length).toBeGreaterThan(0)); });
    return screen;
}
const pickerItems = (screen: Awaited<ReturnType<typeof openModelPicker>>) => screen.findAllByType(DropdownMenu)[1]!.props.items as ReadonlyArray<{ id: string; title: string; subtitle?: string }>;

describe('Editor AI suggestions model picker', () => {
    afterAll(async () => { await account.reset(); });
    let restorePopoverGlobals: (() => void) | undefined;
    afterEach(() => { standardCleanup(); restorePopoverGlobals?.(); });
    beforeEach(async () => {
        restorePopoverGlobals = withPopoverWebGlobals();
        providerHarness.reset();
        routerPush.mockClear();
        savedAllowance = undefined;
        offerNextEditModel = false;
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: connectionId,
            source: { kind: 'contribution', contributionKey: 'happier.provider.ollama/ollama' },
            role: 'named', displayName: 'Ollama', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] });
        await account.reset();
        await account.restore({ accountId: 'account-editor-ai', serverIdentityId: 'srv_editor_ai',
            machines: [{ ...machine, activeAt: Date.now() }], catalog, waivedActions: [],
            settings: { filesEditorAiSuggestionsV1: { ...DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1, enabled: true, connectionId, modelId: seededModelId } } });
        installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId: account.serverId, catalog });
        await account.selectMachine(account.serverId, 'machine-a');
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({ connectionId, contributionKey: 'happier.provider.ollama/ollama',
                displayName: 'Ollama', providerName: 'Ollama', revision: 1 })],
        }));
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, async () => createProviderModelsFixture({
            connectionId, connectionRevision: 1, models: modelRows(), manualModelPolicy: 'allowed', modelLoadAction: 'available',
        }));
        getStorage().getState().applySettingsLocal({ filesEditorAiSuggestionsV1: { ...DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1,
            enabled: true, connectionId, modelId: null } });
    });

    it('shows the saved provider by name on first paint, before any dropdown is opened', async () => {
        const screen = await renderScreen(<FileEditorAiSuggestionSettings machineId="machine-a" serverId={account.serverId} />);
        await flushHookEffects();
        const provider = screen.findAllByType(DropdownMenu)[0]!;
        await act(async () => { await vi.waitFor(() => expect(provider.props.itemTrigger.detailFormatter(null)).toBe('Ollama')); });
        expect(provider.props.open).toBe(false);
    });

    it('does not call a saved provider and model unchosen while their names are still loading', async () => {
        const { t } = await import('@/text');
        savedAllowance = 128;
        // The Machine has not answered yet: the saved choice exists, only its names are unknown.
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, () => new Promise(() => {}));
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, () => new Promise(() => {}));
        getStorage().getState().applySettingsLocal({ filesEditorAiSuggestionsV1: { ...DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1,
            enabled: true, connectionId, modelId: qwen.id } });
        const screen = await renderScreen(<FileEditorAiSuggestionSettings machineId="machine-a" serverId={account.serverId} />);
        await flushHookEffects();
        const [provider, model] = screen.findAllByType(DropdownMenu);
        expect(provider!.props.itemTrigger.detailFormatter(null)).not.toBe(t('files.editing.aiSuggestions.choose'));
        expect(model!.props.itemTrigger.detailFormatter(null)).not.toBe(t('files.editing.aiSuggestions.choose'));
    });

    it('shows the saved model by name on first paint, before any dropdown is opened', async () => {
        savedAllowance = 128;
        getStorage().getState().applySettingsLocal({ filesEditorAiSuggestionsV1: { ...DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1,
            enabled: true, connectionId, modelId: qwen.id } });
        const screen = await renderScreen(<FileEditorAiSuggestionSettings machineId="machine-a" serverId={account.serverId} />);
        await flushHookEffects();
        const model = screen.findAllByType(DropdownMenu)[1]!;
        await act(async () => { await vi.waitFor(() => expect(model.props.itemTrigger.detailFormatter(null)).toBe(qwen.name)); });
        expect(model.props.open).toBe(false);
    });

    it('keeps a model that only lacks an output allowance in the list, and sends its row to that allowance instead of selecting it', async () => {
        const screen = await openModelPicker();
        // Llama declares no editor operation: it stays out. Qwen is listed with the reason.
        expect(pickerItems(screen).map(item => item.title)).toEqual(['Qwen2.5 Coder base']);
        const [row] = pickerItems(screen);
        expect(row!.subtitle).toEqual(expect.any(String));

        // The search field names what it searches, not the global search.
        expect(screen.findAllByType(DropdownMenu)[1]!.props.searchPlaceholder).toBe('files.editing.aiSuggestions.searchModels');
        expect(screen.findAllByType(DropdownMenu)[0]!.props.searchPlaceholder).toBe('files.editing.aiSuggestions.searchProviders');

        await act(async () => { screen.findAllByType(DropdownMenu)[1]!.props.onSelect(row!.id); });
        expect(routerPush).toHaveBeenCalledWith(`/(app)/settings/providers/${connectionId}/models?allowanceFor=${encodeURIComponent(qwen.id)}`);
        expect(getStorage().getState().settings.filesEditorAiSuggestionsV1.modelId).toBeNull();
    });

    it('offers the model as an ordinary choice once its allowance is saved', async () => {
        savedAllowance = 128;
        const screen = await openModelPicker();
        expect(pickerItems(screen)).toEqual([expect.objectContaining({ id: qwen.id, title: 'Qwen2.5 Coder base' })]);
        expect(pickerItems(screen)[0]!.subtitle).not.toEqual(expect.stringContaining('allowance'));
    });

    describe('next-edit model', () => {
        beforeAll(() => { seededModelId = qwen.id; });
        afterAll(() => { seededModelId = null; });
        const nextEditRow = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType(SettingRow)
            .find(row => row.props.setting.anchor === SOURCE_CONTROL_SETTINGS.settings.aiSuggestionsNextEdit.anchor)!;
        const nextEditPicker = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType(DropdownMenu)
            .find(menu => menu.props.itemTrigger?.itemProps?.testID === SOURCE_CONTROL_SETTINGS.settings.aiSuggestionsNextEditModel.anchor)!;

        it('offers only models that predict next edits, and choosing one keeps the ghost-text model', async () => {
            savedAllowance = 128; offerNextEditModel = true;
            getStorage().getState().applySettingsLocal({ filesEditorAiSuggestionsV1: { ...DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1,
                enabled: true, connectionId, modelId: qwen.id } });
            const screen = await renderScreen(<FileEditorAiSuggestionSettings machineId="machine-a" serverId={account.serverId} />);
            await flushHookEffects();
            expect(nextEditPicker(screen)).toBeDefined();
            await act(async () => { nextEditPicker(screen).props.onOpenChange(true); });
            await act(async () => { await vi.waitFor(() => expect(nextEditPicker(screen).props.items.length).toBeGreaterThan(0)); });
            expect(nextEditPicker(screen).props.items.map((item: { id: string }) => item.id)).toEqual([sweep.id]);
            // The ghost-text picker never offers the next-edit-only model.
            expect(screen.findAllByType(DropdownMenu)[1]!.props.items.map((item: { id: string }) => item.id)).not.toContain(sweep.id);

            await act(async () => { nextEditPicker(screen).props.onSelect(sweep.id); });
            await act(async () => { await vi.waitFor(() => expect(getStorage().getState().settings.filesEditorAiSuggestionsV1.nextEditModelId).toBe(sweep.id)); });
            expect(getStorage().getState().settings.filesEditorAiSuggestionsV1.modelId).toBe(qwen.id);
            await act(async () => { await vi.waitFor(() => expect(nextEditPicker(screen).props.itemTrigger.detailFormatter(null)).toBe(sweep.name)); });
            expect(nextEditRow(screen).props.disabled).toBeFalsy();
        });

        it('says no model on the source predicts next edits instead of treating the ghost-text model as one', async () => {
            savedAllowance = 128;
            getStorage().getState().applySettingsLocal({ filesEditorAiSuggestionsV1: { ...DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1,
                enabled: true, connectionId, modelId: qwen.id } });
            const screen = await renderScreen(<FileEditorAiSuggestionSettings machineId="machine-a" serverId={account.serverId} />);
            await flushHookEffects();
            await act(async () => { await vi.waitFor(() => expect(nextEditRow(screen).props.subtitle).toMatch(/^files\.editing\.aiSuggestions\.nextEditNoneOnSource/)); });
            expect(nextEditRow(screen).props.disabled).toBe(true);
            expect(nextEditPicker(screen).props.itemTrigger.itemProps.disabled).toBe(true);
            expect(getStorage().getState().settings.filesEditorAiSuggestionsV1.nextEditModelId).toBeNull();
        });
    });
});
