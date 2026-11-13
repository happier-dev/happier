import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createProjectionDescribeMock,
    createSupportedClaudeProjection,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from '@/__tests__/app/new/pick/testHarness';

enableReactActEnvironment();

const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const describeProjection = createProjectionDescribeMock();
const picker = await installPickerCommonModuleMocks({
    expoRouter: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        params: () => routeParams.value,
    }).module,
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'ios' },
    }),
    projectionSeam: { describe: describeProjection },
});

describe('External Browse default Home source', () => {
    beforeEach(async () => {
        routeParams.value = {
            machineId: 'machine-2',
            agentId: 'claude',
            agentPluginId: 'happier.agent.claude',
            agentLocalId: 'claude',
        };
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { sync } = await import('@/sync/sync');
        expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
        const settings = {
            featureToggles: { 'sessions.direct': true },
            sessionTmuxTmpDir: '/configured/claude',
        };
        picker.homeBoundary.answer(picker.accountScope.serverId, '/v2/account/settings', {
            body: { content: { t: 'plain', v: settings }, version: 1 },
        });
        storage.getState().applySettingsLocal(settings);
        picker.homeBoundary.answer(picker.accountScope.serverId, ACP_CATALOG_ROWS_ROUTE_V1, {
            body: AcpCatalogRowReadResponseV1Schema.parse({
                status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
            }),
        });
        const projection = createSupportedClaudeProjection();
        const source = projection.agentsById.claude?.externalSessions?.sources[0];
        if (!source) throw new Error('Claude source declaration unavailable');
        // A daemon-declared source reads a real Account path setting. Keep the
        // settings reader, projection hook, route and source materializer real.
        source.instances = [{ kind: 'default', constants: {} }, {
            kind: 'agentSettingOverride', settingId: 'sessionTmuxTmpDir', field: 'configDir',
            normalization: 'configuredPath', constants: {},
        }];
        describeProjection.mockResolvedValue({ supported: true, projection });
    });

    afterEach(() => standardCleanup());

    it('keeps the active Home configured source when the route omits serverId', async () => {
        const { WorkspaceRouteBody } = await import('@/app/(app)/external/browse');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const screen = await renderScreen(<WorkspaceRouteBody />);

        await vi.waitFor(() => {
            expect(getActiveServerAccountScope()).toEqual(picker.accountScope);
            expect(storage.getState().settings.sessionTmuxTmpDir).toBe('/configured/claude');
            expect(screen.root.find(node => node.props.lockScope?.providerId === 'claude').props.lockScope).toEqual({
                machineId: 'machine-2',
                serverId: null,
                providerId: 'claude',
                source: { kind: 'claudeConfig', configDir: '/configured/claude' },
            });
        });
    });
});
