import { afterEach, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesDescribeResponse } from '@happier-dev/protocol';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import type { CapabilitiesDetectResponse } from '@/capabilities/types';

import { reloadConfiguration } from '@/configuration';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerCapabilitiesHandlers } from './capabilities';

const environment = createEnvKeyScope(['HAPPIER_HOME_DIR']);
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
    environment.restore();
    reloadConfiguration();
});

function authoredAgent(pluginId: string) {
    return {
        manifest: createPluginManifestV2Fixture({
            id: pluginId,
            contributes: { systemTools: [{
                id: 'fixture-acp', title: 'Fixture ACP', executableNames: ['fixture-acp'],
            }], agents: [{
                id: 'fixture', title: 'Capability fixture',
                primary: 'sessions',
                runtime: { kind: 'acp', transport: {
                    kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-acp' },
                } },
                capabilities: { sessions: {
                    open: ['create'], delivery: ['newTurn'], cancel: true,
                } },
            }] },
        }),
        files: { 'daemon.mjs': 'export function activate() {}' },
    };
}

describe('registerCapabilitiesHandlers prewarm', () => {
    it('serves the admitted registry snapshot and refreshes it only after runtime publication', async () => {
        const first = await createAuthoredAdmittedPluginRuntimeFixture({
            controller: pluginReloadController,
            plugins: [authoredAgent('acme.capabilities-first')],
        });
        disposers.push(first.dispose);
        environment.patch({ HAPPIER_HOME_DIR: first.happyHomeDir });
        reloadConfiguration();

        const firstAgent = first.registry.contributes.agents.find((entry) => entry.pluginId === 'acme.capabilities-first');
        if (!firstAgent) throw new Error('Expected the admitted first Agent');
        const { call } = createEncryptedRpcTestClient({
            scopePrefix: 'machine-test', encryptionKey: new Uint8Array(32).fill(7),
            logger: () => undefined,
            registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
        });
        const describeCapabilities = () => call<CapabilitiesDescribeResponse, Record<string, never>>(
            RPC_METHODS.CAPABILITIES_DESCRIBE, {},
        );
        const before = await describeCapabilities();
        expect(before.capabilities).toContainEqual(expect.objectContaining({ id: `cli.${firstAgent.id}` }));
        expect(before.checklists[CHECKLIST_IDS.NEW_SESSION]).toContainEqual({ id: `cli.${firstAgent.id}` });
        const ordinary = await call<CapabilitiesDetectResponse, { checklistId: string }>(
            RPC_METHODS.CAPABILITIES_DETECT, { checklistId: CHECKLIST_IDS.NEW_SESSION },
        );
        const focused = await call<CapabilitiesDetectResponse, { requests: Array<{ id: string }> }>(
            RPC_METHODS.CAPABILITIES_DETECT, { requests: [{ id: `cli.${firstAgent.id}` }] },
        );
        const focusedResult = focused.results[`cli.${firstAgent.id}`];
        if (!focusedResult) throw new Error('Expected the focused Agent detection result');
        // The fixture has no installed executable. Both entry points must retain
        // its real outcome, including a probe refusal, rather than drop its row.
        expect(ordinary.results[`cli.${firstAgent.id}`]).toMatchObject(
            focusedResult.ok
                ? { ok: true, data: focusedResult.data }
                : { ok: false, error: focusedResult.error },
        );

        // Source admission alone does not replace this daemon's published runtime.
        const successor = await createAuthoredAdmittedPluginRuntimeFixture({
            happyHomeDir: first.happyHomeDir,
            plugins: [authoredAgent('acme.capabilities-second')],
            runtimeOptions: { pluginIds: ['acme.capabilities-first', 'acme.capabilities-second'] },
        });
        disposers.push(successor.dispose);
        const secondAgent = successor.registry.contributes.agents.find((entry) => entry.pluginId === 'acme.capabilities-second');
        if (!secondAgent) throw new Error('Expected the admitted successor Agent');
        const unpublished = await describeCapabilities();
        expect(unpublished.capabilities).toEqual(before.capabilities);
        expect(unpublished.capabilities.some((entry) => entry.id === `cli.${secondAgent.id}`)).toBe(false);

        const publication = await pluginReloadController.adoptPreparedRuntimeRegistry({
            registry: successor.registry,
            changedPluginIds: ['acme.capabilities-second'],
            runningSessionDisposition: 'retainRunningSessions',
        });
        expect(publication.ok).toBe(true);
        const after = await describeCapabilities();
        expect(after.capabilities).toContainEqual(expect.objectContaining({ id: `cli.${firstAgent.id}` }));
        expect(after.capabilities).toContainEqual(expect.objectContaining({ id: `cli.${secondAgent.id}` }));
        expect(after.checklists[CHECKLIST_IDS.NEW_SESSION]).toEqual(expect.arrayContaining([
            { id: `cli.${firstAgent.id}` }, { id: `cli.${secondAgent.id}` },
        ]));
    });
});
