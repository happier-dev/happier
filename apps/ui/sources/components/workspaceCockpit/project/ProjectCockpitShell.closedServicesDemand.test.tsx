import * as React from 'react';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { renderScreen } from '@/dev/testkit';
import { resetLocalServicePreviewStoreForTests } from '@/sync/domains/local/services/preview/sharedStore';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
}));

const machineRpc = vi.hoisted(() => vi.fn(async (input: Readonly<{ method: string; machineId: string }>) => {
    if (input.method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT) {
        throw new Error(`Unexpected machine RPC: ${input.method}`);
    }
    return {
        protocolVersion: 1,
        snapshot: {
            v: 1,
            machineId: input.machineId,
            generatedAt: 1,
            refreshState: 'idle',
            resources: [],
            previews: [],
            diagnostics: [],
        },
    };
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpc,
}));

const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: 'project:wr_closed_services',
});

describe('ProjectCockpitShell closed Services demand', () => {
    beforeEach(() => {
        machineRpc.mockClear();
        resetLocalServicePreviewStoreForTests();
    });

    afterEach(() => {
        resetLocalServicePreviewStoreForTests();
    });

    it('does not read service previews for 24 projects with Services closed', async () => {
        const { ProjectCockpitShell } = await import('./ProjectCockpitShell');
        await renderScreen(
            <runtime.Wrapper>
                {Array.from({ length: 24 }, (_, index) => (
                    <ProjectCockpitShell
                        key={index}
                        workspaceRef={{
                            id: `wr_${index}`,
                            serverId: runtime.serverId,
                            machineId: `machine_${index}`,
                            rootPath: `/repo/${index}`,
                            createdAtMs: index + 1,
                        }}
                        scopeId={`project:wr_${index}`}
                        activeRootPath={`/repo/${index}`}
                        surface="scripts"
                        isFocused
                        onSelectRootPath={() => {}}
                    />
                ))}
            </runtime.Wrapper>
        );

        expect(machineRpc.mock.calls.filter(([input]) => (
            input.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT
        ))).toHaveLength(0);
    }, 180_000);
});
