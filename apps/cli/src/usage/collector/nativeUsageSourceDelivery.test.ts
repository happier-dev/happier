import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import { measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '@happier-dev/protocol/actions/externalActionLimits';
import { UsageSourcesListV1Schema } from '@happier-dev/protocol/usage/usageSources';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { registerMachineUsageSourceRpcHandlers } from '@/api/machine/rpcHandlers.usageSources';
import { createNativeUsageCaptureStore, type NativeUsageCaptureSource } from './nativeUsageCaptureState';
import { deriveNativeUsageAccountingIdentity } from './nativeUsageAccountingIdentity';
import { createNativeUsageCollector } from './nativeUsageCollector';
import { discoverNativeUsageSourceMetadata } from './nativeUsageSourceDiscovery';

describe('native source Action delivery', () => {
    it('summarizes 288 retained roots for agents and recovers exact source detail', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-source-delivery-'));
        const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
        const authority = { serverId: 'home', accountId: 'account', machineId: 'machine' };
        const store = createNativeUsageCaptureStore({ path: join(directory, 'capture.sealed'), authority, storage });
        // Root changes retain previous capture custody. Model the specified scale
        // through the real sealed store and real opaque identity producer.
        const retained = Array.from({ length: 288 }, (_, index): NativeUsageCaptureSource => {
            const root = join(directory, 'configured', `root-${index}`);
            const agent = index % 2 === 0 ? { pluginId: 'happier.agent.claude', localId: 'claude' }
                : { pluginId: 'happier.agent.pi', localId: 'pi' };
            const source: NativeUsageCaptureSource['source'] = index % 2 === 0 ? { kind: 'claudeConfig', configDir: root }
                : { kind: 'piAgentDir', agentDir: root };
            const sourceKey = JSON.stringify(source);
            return { agent, sourceKey, source, root,
                sourceId: deriveNativeUsageAccountingIdentity({ authority, storage, agent, sourceKey }).sourceRootKey,
                supported: index % 3 !== 0, consented: false, pending: [], cursor: 'retained-cursor',
                ...(index % 3 === 1 ? { error: 'source_unavailable' } : {}),
            };
        });
        await store.save({ v: 1, authority, sources: retained });
        const unused = async (): Promise<never> => { throw new Error('Unconsented metadata read cannot capture or mutate'); };
        const collector = createNativeUsageCollector({ authority, storage, store,
            budgetRegistry: new ExecutionBudgetRegistry(),
            discoverSources: () => discoverNativeUsageSourceMetadata({ agents: [], account: { connectedServicesV2: [] },
                activeServerId: authority.serverId, activeServerDir: directory, signal: new AbortController().signal,
                resolveBoundary: async () => null }),
            resolveRoot: unused, readAccounting: unused, subscribeSource: unused,
            publisher: { publish: unused }, deleteHistory: unused,
        });
        const handlers = new Map<string, RpcHandler>();
        registerMachineUsageSourceRpcHandlers({ ...authority, custodianAccountId: authority.accountId,
            installationId: 'installation', service: collector,
            rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler); } },
        });
        const context: RpcHandlerContext = { signal: new AbortController().signal,
            machineAdmission: { actorAccountId: authority.accountId, custodianAccountId: authority.accountId,
                machineId: authority.machineId, installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true,
        };
        const executor = createActionExecutor({
            usageSourceAction: createUsageSourceActionPort({ serverId: authority.serverId, assertCurrent() {},
                // In-process Machine RPC boundary; admission, collector and parser remain real.
                rpc: async request => {
                    const handler = handlers.get(request.actionId);
                    if (!handler) throw new Error('Missing registered source RPC');
                    return handler(request.input, context);
                },
            }),
        });
        try {
            const raw = UsageSourcesListV1Schema.parse({ sources: await collector.get() });
            expect(raw.sources).toHaveLength(288);
            // Pi's existing tool-output boundary is 50 KiB, not a new Usage cap.
            expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(raw)).toBeGreaterThan(50 * 1024);
            for (const actionId of ['usage.sources.discover', 'usage.sources.get'] as const) {
                for (const surface of ['agent', 'mcp'] as const) {
                    const delivered = await executor.execute(actionId, { serverId: authority.serverId, machineId: authority.machineId },
                        { surface, authority: 'present_user', serverId: authority.serverId });
                    expect(delivered.ok).toBe(true);
                    if (!delivered.ok) throw new Error('Expected source summary');
                    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(delivered.result)).toBeLessThan(50 * 1024);
                    expect(getActionSpec(actionId).outputSchema!.safeParse(delivered.result).success).toBe(true);
                    expect(delivered.result).toEqual({ sources: [], summary: { sourceCount: 288, groups: [
                        ['claude', 'unsupported', 'unsupported'], ['pi', 'unavailable', 'unknown'],
                        ['claude', 'stopped', 'unknown'], ['pi', 'unsupported', 'unsupported'],
                        ['claude', 'unavailable', 'unknown'], ['pi', 'stopped', 'unknown'],
                    ].map(([agent, status, coverage]) => ({ agent: { pluginId: `happier.agent.${agent}`, localId: agent },
                        consent: 'disabled', status, coverage, sourceCount: 48, pendingCount: 0,
                        sources: raw.sources.filter(source => source.status === status && source.agent.localId === agent)
                            .map(source => ({ sourceId: source.sourceId })),
                    })) } });
                    const detail = await executor.execute('usage.sources.get', { serverId: authority.serverId,
                        machineId: authority.machineId, sourceId: raw.sources[140].sourceId },
                    { surface, authority: 'present_user', serverId: authority.serverId });
                    expect(detail).toEqual({ ok: true, result: { sources: [raw.sources[140]] } });
                }
                for (const surface of ['ui', 'cli'] as const) {
                    expect(await executor.execute(actionId, { serverId: authority.serverId, machineId: authority.machineId },
                        { surface, authority: 'present_user', serverId: authority.serverId })).toEqual({ ok: true, result: raw });
                }
            }
        } finally { await collector.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
});
