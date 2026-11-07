import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
    ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';

installSettingsViewCommonModuleMocks({ storage: 'real' });
// Native recycler layout is a system boundary; render its rows through the canonical testkit.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});
// Machine transport is a genuine boundary. No Account operation may reach it.
const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));
const account = createProviderSettingsAccountHarness();
beforeAll(loadSyncSingletonForTests);
afterEach(async () => { standardCleanup(); await account.reset(); machineRpcWithServerScope.mockReset(); });

function customTemplate() {
    return buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
        name: 'Account source', baseUrl: 'https://models.example.test/v1', requiresApiKey: false });
}

// A saved custom connection reopens in the custom editor it was added with (F08). Its own file: rendering a
// second Provider screen in one module after an Account reset leaves the Providers feature decision at
// `unsupported_context` (observed in providerAccountActions.test.tsx), a harness leak this lane did not own.
describe('ProviderCustomConnectionEditScreen', () => {
    it('edits a saved custom connection in the editor it was added with, without a machine (F08)', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 3, createdAt: 1, updatedAt: 1 }],
            manualModelsByConnectionId: { pc_account: [{ id: 'kept-model', addedAt: 1 }] },
        });
        let revision = 1;
        const { serverId } = await account.restore({ catalog, machines: [], waivedActions: ['providers.connections.update'] });
        // No machine at all: the edit is Account data (D11).
        await account.selectMachine(serverId, null);
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account write');
                catalog = mutation.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const [{ ProviderCustomConnectionEditScreen }, { FieldTextInput }] = await Promise.all([
            import('@/components/settings/providers/ProviderConnectionAuthoringScreen'),
            import('@/components/ui/forms/FieldTextInput'),
        ]);
        const screen = await renderScreen(<ProviderCustomConnectionEditScreen connectionId="pc_account" />);
        const baseUrl = () => screen.findAllByType(FieldTextInput)
            .find((field) => field.props.testID === 'settings-provider-authoring-base-url');
        await waitForHomeGovernance(() => expect(baseUrl()?.props.value).toBe('https://models.example.test/v1'));
        // Its key, models and on/off switch belong to the saved provider's page, not to this editor.
        expect(screen.findByTestId('settings-provider-authoring-enable-after-save')).toBeNull();
        expect(screen.findByTestId('provider-manual-model-ids')).toBeNull();
        await act(async () => { baseUrl()?.props.onChangeText('https://corrected.example.test/v1'); });
        // Same readiness the CRUD journey waits for before its first Account write.
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const actions = await renderHook(() => useProviderActionClient(serverId));
        await waitForHomeGovernance(() => expect(actions.getCurrent().ready).toBe(true));
        const save = screen.findAllByTestId('settings-provider-authoring-save')
            .find((node) => typeof node.props.onPress === 'function');
        expect(save).toBeDefined();
        await act(async () => { await save?.props.onPress?.(); });
        await waitForHomeGovernance(() => expect(catalog.connections[0]).toMatchObject({
            id: 'pc_account', revision: 4,
            source: { kind: 'custom', template: { name: 'Account source',
                endpointTemplates: [{ baseUrl: 'https://corrected.example.test/v1' }] } },
        }));
        expect(catalog.manualModelsByConnectionId[ProviderConnectionIdSchema.parse('pc_account')]).toMatchObject([{ id: 'kept-model' }]);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
});
