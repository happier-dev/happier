import { describe, expect, it, vi } from 'vitest';

import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';

import { projectPluginSessionHookStatusInventory } from './pluginSessionHookStatusInventory';

function agent(localId: string): PluginContributionIdentityV1 {
    return {
        pluginId: 'happier.agent.fixture',
        localId,
    };
}

describe('projectPluginSessionHookStatusInventory', () => {
    it('uses one deterministic Agent-key order across current pages', async () => {
        const currentAgents = [agent('b'), agent('b-c')];
        const dependencies = {
            listCurrentAgents: () => currentAgents,
            readCustodyPage: vi.fn(async () => ({
                ok: true as const,
                records: [],
                diagnostics: [],
            })),
            resolveCurrentStatus: vi.fn(async () => ({
                state: 'not_installed' as const,
            })),
        };
        const observedLocalIds: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await projectPluginSessionHookStatusInventory({
                machineId: 'machine-1',
                intent: 'passive_inventory',
                limit: 1,
                ...(cursor ? { cursor } : {}),
            }, dependencies);
            if (!page.ok) throw new Error('Expected current-Agent inventory');
            observedLocalIds.push(...page.rows.map((row) => row.agent.localId));
            cursor = page.nextCursor ?? undefined;
        } while (cursor);

        expect(observedLocalIds).toEqual(['b', 'b-c']);
    });

    it('resumes after the last Agent descriptor key when current contributions move between pages', async () => {
        let currentAgents = [agent('bravo'), agent('charlie')];
        const dependencies = {
            listCurrentAgents: () => currentAgents,
            readCustodyPage: vi.fn(async () => ({
                ok: true as const,
                records: [],
                diagnostics: [],
            })),
            resolveCurrentStatus: vi.fn(async () => ({
                state: 'unsupported' as const,
                reason: 'installation_unsupported' as const,
            })),
        };

        const first = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            limit: 1,
        }, dependencies);
        expect(first).toMatchObject({
            ok: true,
            rows: [{ agent: agent('bravo') }],
        });
        if (!first.ok || first.nextCursor === null) {
            throw new Error('Expected a second inventory page');
        }

        currentAgents = [
            agent('alpha'),
            agent('bravo'),
            agent('charlie'),
        ];
        const second = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            limit: 1,
            cursor: first.nextCursor,
        }, dependencies);

        expect(second).toMatchObject({
            ok: true,
            rows: [{ agent: agent('charlie') }],
        });
    });

    it('does not skip the next Agent when an earlier contribution retires between pages', async () => {
        let currentAgents = [
            agent('alpha'),
            agent('bravo'),
            agent('charlie'),
        ];
        const dependencies = {
            listCurrentAgents: () => currentAgents,
            readCustodyPage: vi.fn(async () => ({
                ok: true as const,
                records: [],
                diagnostics: [],
            })),
            resolveCurrentStatus: vi.fn(async () => ({
                state: 'unsupported' as const,
                reason: 'installation_unsupported' as const,
            })),
        };

        const first = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            limit: 1,
        }, dependencies);
        if (!first.ok || first.nextCursor === null) {
            throw new Error('Expected a second inventory page');
        }

        currentAgents = [agent('bravo'), agent('charlie')];
        const second = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            limit: 1,
            cursor: first.nextCursor,
        }, dependencies);

        expect(second).toMatchObject({
            ok: true,
            rows: [{ agent: agent('bravo') }],
        });
    });

    it('rejects a passive cursor replayed across machine or Agent scope', async () => {
        const exactAgent = agent('alpha');
        const dependencies = {
            listCurrentAgents: () => [exactAgent],
            readCustodyPage: vi.fn(async ({ cursor }: { cursor?: string }) => ({
                ok: true as const,
                records: cursor
                    ? []
                    : [{
                        machineId: 'machine-1',
                        qualifiedAgent: exactAgent,
                        installationId: 'installation-1',
                        variantId: 'variant-1',
                        state: 'disabled' as const,
                        updatedAtMs: 1,
                        revision: 1,
                    }],
                diagnostics: [],
                ...(cursor ? {} : { nextCursor: 'custody-page-2' }),
            })),
            resolveCurrentStatus: vi.fn(async () => ({
                state: 'installed_disabled' as const,
                installationId: 'installation-1',
            })),
        };

        const first = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            agent: exactAgent,
            limit: 1,
        }, dependencies);
        if (!first.ok || first.nextCursor === null) {
            throw new Error('Expected a second inventory page');
        }

        for (const input of [
            {
                machineId: 'machine-2',
                intent: 'passive_inventory' as const,
                agent: exactAgent,
            },
            {
                machineId: 'machine-1',
                intent: 'passive_inventory' as const,
                agent: agent('bravo'),
            },
        ]) {
            await expect(projectPluginSessionHookStatusInventory({
                ...input,
                limit: 1,
                cursor: first.nextCursor,
            }, dependencies)).resolves.toMatchObject({
                ok: false,
                diagnostic: { code: 'operation_failed' },
            });
        }
        expect(dependencies.readCustodyPage).toHaveBeenCalledOnce();
    });

    it('rejects superseded cursor orders before custody reads', async () => {
        const readCustodyPage = vi.fn();
        for (const version of [3, 4]) {
            const cursor = Buffer.from(JSON.stringify({
                v: version,
                scope: {
                    intent: 'passive_inventory',
                    machineId: 'machine-1',
                    agentKey: null,
                },
                phase: 'current',
                afterAgentKey: null,
                ...(version === 3
                    ? { emitted: false }
                    : { hasCustody: false }),
            }), 'utf8').toString('base64url');

            await expect(projectPluginSessionHookStatusInventory({
                machineId: 'machine-1',
                intent: 'passive_inventory',
                limit: 1,
                cursor,
            }, {
                listCurrentAgents: () => [],
                readCustodyPage,
                resolveCurrentStatus: vi.fn(),
            })).resolves.toMatchObject({
                ok: false,
                diagnostic: { code: 'operation_failed' },
            });
        }
        expect(readCustodyPage).not.toHaveBeenCalled();
    });

    it('projects current durable custody once through the current status owner', async () => {
        const currentAgent = agent('alpha');
        const record = {
            machineId: 'machine-1',
            qualifiedAgent: currentAgent,
            installationId: 'installation-1',
            variantId: 'variant-1',
            state: 'active' as const,
            updatedAtMs: 1,
            revision: 1,
        };
        const readCustodyPage = vi.fn(async () => ({
            ok: true as const,
            records: [record],
            diagnostics: [],
        }));
        const resolveCurrentStatus = vi.fn(async () => ({
            state: 'installed_enabled' as const,
            installationId: record.installationId,
        }));

        const result = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
        }, {
            listCurrentAgents: () => [currentAgent],
            readCustodyPage,
            resolveCurrentStatus,
        });

        expect(result).toEqual({
            ok: true,
            rows: [{
                agent: currentAgent,
                status: {
                    state: 'installed_enabled',
                    installationId: record.installationId,
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });
        expect(resolveCurrentStatus).toHaveBeenCalledOnce();
    });

    it('reports each invalid or read-failed custody record once while retaining partial rows', async () => {
        const currentAgent = agent('alpha');
        const unavailableAgent = agent('bravo');
        const diagnostics = [
            {
                code: 'invalid_record' as const,
                recordRef: 'a'.repeat(64),
            },
            {
                code: 'record_read_failed' as const,
                recordRef: 'b'.repeat(64),
            },
        ];
        const dependencies = {
            listCurrentAgents: () => [currentAgent],
            readCustodyPage: vi.fn(async (
                input: { qualifiedAgent?: PluginContributionIdentityV1 },
            ) => ({
                ok: true as const,
                records: input.qualifiedAgent
                    ? []
                    : [{
                        machineId: 'machine-1',
                        qualifiedAgent: unavailableAgent,
                        installationId: 'installation-1',
                        variantId: 'variant-1',
                        state: 'active' as const,
                        updatedAtMs: 1,
                        revision: 1,
                    }],
                diagnostics,
            })),
            resolveCurrentStatus: vi.fn(async () => ({
                state: 'not_installed' as const,
            })),
        };

        await expect(projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
        }, dependencies)).resolves.toEqual({
            ok: true,
            rows: [
                {
                    agent: unavailableAgent,
                    status: {
                        state: 'unavailable',
                        installationId: 'installation-1',
                    },
                },
                {
                    agent: currentAgent,
                    status: { state: 'not_installed' },
                },
            ],
            nextCursor: null,
            diagnostics: [
                {
                    code: 'installation_record_invalid',
                    retryable: false,
                },
                {
                    code: 'installation_record_read_failed',
                    retryable: true,
                },
            ],
        });

        await expect(projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            agent: currentAgent,
        }, dependencies)).resolves.toMatchObject({
            ok: true,
            rows: [{
                agent: currentAgent,
                status: { state: 'not_installed' },
            }],
            diagnostics: [
                {
                    code: 'installation_record_invalid',
                    retryable: false,
                },
                {
                    code: 'installation_record_read_failed',
                    retryable: true,
                },
            ],
        });
        expect(dependencies.readCustodyPage).toHaveBeenCalledTimes(3);
    });

    it('reports current-Agent custody failures on a full limit-one page', async () => {
        const currentAgent = agent('alpha');
        const dependencies = {
            listCurrentAgents: () => [currentAgent],
            readCustodyPage: vi.fn(async () => ({
                ok: true as const,
                records: [],
                diagnostics: [{
                    code: 'invalid_record' as const,
                    recordRef: 'a'.repeat(64),
                }],
            })),
            resolveCurrentStatus: vi.fn(async () => ({
                state: 'not_installed' as const,
            })),
        };

        const result = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            limit: 1,
        }, dependencies);

        expect(result).toMatchObject({
            ok: true,
            rows: [{
                agent: currentAgent,
                status: { state: 'not_installed' },
            }],
            diagnostics: [{
                code: 'installation_record_invalid',
                retryable: false,
            }],
        });
        if (!result.ok || result.nextCursor === null) {
            throw new Error('Expected the terminal current-Agent cursor');
        }
        const terminal = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            limit: 1,
            cursor: result.nextCursor,
        }, dependencies);
        expect(terminal).toEqual({
            ok: true,
            rows: [],
            nextCursor: null,
            diagnostics: [],
        });
        if (!terminal.ok) throw new Error('Expected terminal inventory page');
        expect([...result.rows, ...terminal.rows]).toHaveLength(1);
        expect(dependencies.readCustodyPage).toHaveBeenCalledTimes(2);
    });

    it('bounds diagnostics from more than thirty-two failed custody records', async () => {
        const failedDiagnostics = Array.from({ length: 40 }, (_, index) => ({
            code: index % 2 === 0
                ? 'invalid_record' as const
                : 'record_read_failed' as const,
            recordRef: index.toString(16).padStart(64, '0'),
        }));

        const result = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
        }, {
            listCurrentAgents: () => [],
            readCustodyPage: vi.fn(async () => ({
                ok: true as const,
                records: [],
                diagnostics: failedDiagnostics,
            })),
            resolveCurrentStatus: vi.fn(),
        });

        expect(result).toMatchObject({
            ok: true,
            rows: [],
            nextCursor: null,
        });
        if (!result.ok) throw new Error('Expected partial inventory');
        expect(result.diagnostics).toHaveLength(32);
        expect(result.diagnostics.filter(
            (diagnostic) => diagnostic.code === 'installation_record_invalid',
        )).toHaveLength(16);
        expect(result.diagnostics.filter(
            (diagnostic) =>
                diagnostic.code === 'installation_record_read_failed',
        )).toHaveLength(16);
    });

    it('returns a continuation after at most one hundred custody pages', async () => {
        let page = 0;
        const readCustodyPage = vi.fn(async () => ({
            ok: true as const,
            records: [],
            diagnostics: [],
            nextCursor: `custody-${page += 1}`,
        }));

        const result = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            limit: 1,
        }, {
            listCurrentAgents: () => [],
            readCustodyPage,
            resolveCurrentStatus: vi.fn(),
        });

        expect(result).toMatchObject({
            ok: true,
            rows: [],
            nextCursor: expect.any(String),
            diagnostics: [],
        });
        expect(readCustodyPage).toHaveBeenCalledTimes(100);
    });

    it('shares the one-hundred-page budget across custody and current phases', async () => {
        const currentAgent = agent('alpha');
        let globalPages = 0;
        let filteredPages = 0;
        const readCustodyPage = vi.fn(async (
            input: {
                qualifiedAgent?: PluginContributionIdentityV1;
                cursor?: string;
            },
        ) => {
            if (input.qualifiedAgent) {
                filteredPages += 1;
                return {
                    ok: true as const,
                    records: [],
                    diagnostics: [],
                    nextCursor: `filtered-${filteredPages}`,
                };
            }
            globalPages += 1;
            return {
                ok: true as const,
                records: [],
                diagnostics: [],
                ...(globalPages < 99
                    ? { nextCursor: `global-${globalPages}` }
                    : {}),
            };
        });

        const result = await projectPluginSessionHookStatusInventory({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            limit: 1,
        }, {
            listCurrentAgents: () => [currentAgent],
            readCustodyPage,
            resolveCurrentStatus: vi.fn(),
        });

        expect(result).toMatchObject({
            ok: true,
            rows: [],
            nextCursor: expect.any(String),
            diagnostics: [],
        });
        expect(globalPages).toBe(99);
        expect(filteredPages).toBe(1);
        expect(readCustodyPage).toHaveBeenCalledTimes(100);
    });

});
