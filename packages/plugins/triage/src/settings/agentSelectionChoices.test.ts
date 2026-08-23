import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@happier-dev/plugin-sdk';

import type { TriageAgentSelectionV1 } from './agentSelection.js';
import {
    listTriageAgentChoices,
    listTriageAgentModelChoices,
    resolveTriageAgentSpawnSelection,
    type TriageAgentChoiceV1,
    type TriageAgentInventoryInvokerV1,
} from './agentSelectionChoices.js';

const CLAUDE_KEY = 'agent:happier.claude/claude';
const CODEX_KEY = 'agent:happier.codex/codex';
const CLAUDE_IDENTITY = Object.freeze({ pluginId: 'happier.claude', localId: 'claude' });

type InventoryCall = Readonly<{ actionId: string; input: unknown }>;

function createInventory(results: Readonly<{
    backends?: unknown;
    models?: unknown;
}>): Readonly<{ execute: TriageAgentInventoryInvokerV1; calls: readonly InventoryCall[] }> {
    const calls: InventoryCall[] = [];
    const execute = (async (actionId: string, input: unknown) => {
        calls.push({ actionId, input });
        if (actionId === 'agents.backends.list') return results.backends ?? { items: [] };
        return results.models ?? null;
    }) as unknown as TriageAgentInventoryInvokerV1;
    return { execute, calls };
}

function choice(overrides: Partial<TriageAgentChoiceV1> = {}): TriageAgentChoiceV1 {
    return {
        agentTargetKey: CLAUDE_KEY,
        label: 'Claude',
        description: null,
        agentTarget: { kind: 'agent', identity: CLAUDE_IDENTITY },
        ...overrides,
    };
}

function selection(overrides: Partial<TriageAgentSelectionV1> = {}): TriageAgentSelectionV1 {
    return { agentTargetKey: CLAUDE_KEY, model: null, ...overrides };
}

describe('listTriageAgentChoices', () => {
    it('projects the agents the host enumerates, never a list of its own', async () => {
        const inventory = createInventory({
            backends: {
                items: [
                    { targetKey: CLAUDE_KEY, label: 'Claude', enabled: true, agentId: 'claude', identity: CLAUDE_IDENTITY },
                    {
                        targetKey: CODEX_KEY,
                        label: 'Codex',
                        description: 'OpenAI Codex',
                        enabled: true,
                        agentId: 'codex',
                        identity: { pluginId: 'happier.codex', localId: 'codex' },
                    },
                ],
            },
        });

        const choices = await listTriageAgentChoices({ execute: inventory.execute });

        expect(inventory.calls).toEqual([
            { actionId: 'agents.backends.list', input: { includeDisabled: false } },
        ]);
        expect(choices).toEqual([
            choice(),
            {
                agentTargetKey: CODEX_KEY,
                label: 'Codex',
                description: 'OpenAI Codex',
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.codex', localId: 'codex' } },
            },
        ]);
    });

    it('never offers an agent that cannot start a session', async () => {
        // Both rows below are real shapes the host inventory produces: a
        // disabled agent, and a configured ACP backend, which carries no
        // qualified Agent identity and therefore cannot be a `session.spawn_new`
        // agent target at all. Offering either would put a choice in Triage
        // settings that always fails at start time.
        const inventory = createInventory({
            backends: {
                items: [
                    { targetKey: CLAUDE_KEY, label: 'Claude', enabled: false, agentId: 'claude', identity: CLAUDE_IDENTITY },
                    { targetKey: 'backend:my-acp:configured:my-acp', label: 'My ACP', enabled: true, backendId: 'my-acp' },
                    { targetKey: CODEX_KEY, label: 'Codex', enabled: true, agentId: 'codex' },
                ],
            },
        });

        expect(await listTriageAgentChoices({ execute: inventory.execute })).toEqual([]);
    });

    it('drops a row whose identity or key the canonical contract would refuse', async () => {
        const inventory = createInventory({
            backends: {
                items: [
                    { targetKey: '  ', label: 'Blank', enabled: true, identity: CLAUDE_IDENTITY },
                    { targetKey: CLAUDE_KEY, label: '', enabled: true, identity: CLAUDE_IDENTITY },
                    { targetKey: CODEX_KEY, label: 'Codex', enabled: true, identity: { pluginId: '', localId: 'codex' } },
                ],
            },
        });

        expect(await listTriageAgentChoices({ execute: inventory.execute })).toEqual([]);
    });

    it('reads a host answer it cannot understand as no agents rather than throwing', async () => {
        const inventory = createInventory({ backends: { items: 'not-a-list' } });

        expect(await listTriageAgentChoices({ execute: inventory.execute })).toEqual([]);
    });
});

describe('listTriageAgentModelChoices', () => {
    it('asks the host for the models of exactly the chosen agent', async () => {
        const inventory = createInventory({
            models: {
                items: [
                    { id: 'claude-opus-4-8', label: 'Claude Opus' },
                    { id: 'claude-haiku', label: 'Claude Haiku', description: 'Fast' },
                ],
                supportsFreeform: true,
            } as unknown as JsonValue,
        });

        const models = await listTriageAgentModelChoices({
            execute: inventory.execute,
            agentTargetKey: CLAUDE_KEY,
        });

        expect(inventory.calls).toEqual([
            { actionId: 'agents.models.list', input: { backendTargetKey: CLAUDE_KEY } },
        ]);
        expect(models).toEqual({
            models: [
                { modelId: 'claude-opus-4-8', label: 'Claude Opus', description: null },
                { modelId: 'claude-haiku', label: 'Claude Haiku', description: 'Fast' },
            ],
            supportsFreeform: true,
        });
    });

    it('drops the host default sentinel, which this setting already expresses by holding no model', async () => {
        const inventory = createInventory({
            models: { items: [{ id: 'default', label: 'Default' }] } as unknown as JsonValue,
        });

        expect(await listTriageAgentModelChoices({
            execute: inventory.execute,
            agentTargetKey: CLAUDE_KEY,
        })).toEqual({ models: [], supportsFreeform: false });
    });

    it('reads a host answer it cannot understand as no models rather than throwing', async () => {
        const inventory = createInventory({ models: null });

        expect(await listTriageAgentModelChoices({
            execute: inventory.execute,
            agentTargetKey: CLAUDE_KEY,
        })).toEqual({ models: [], supportsFreeform: false });
    });
});

describe('resolveTriageAgentSpawnSelection', () => {
    it('reports an unset intent as unset, never as some agent', () => {
        // `unset` is the contract the generic new-session flow depends on. A
        // resolution that answered with the first enumerated agent here would
        // silently route every Ask at whatever the host happened to list first.
        expect(resolveTriageAgentSpawnSelection({
            selection: null,
            choices: [choice(), choice({ agentTargetKey: CODEX_KEY })],
        })).toEqual({ status: 'unset' });
    });

    it('resolves a chosen agent to the exact canonical session target', () => {
        expect(resolveTriageAgentSpawnSelection({
            selection: selection(),
            choices: [choice({ agentTargetKey: CODEX_KEY, label: 'Codex' }), choice()],
        })).toEqual({
            status: 'resolved',
            agentTarget: { kind: 'agent', identity: CLAUDE_IDENTITY },
            modelSelection: null,
        });
    });

    it('carries the chosen model as the canonical selection bound to the chosen agent', () => {
        expect(resolveTriageAgentSpawnSelection({
            selection: selection({
                model: { modelId: 'claude-opus-4-8', providerConnectionId: null, updatedAt: 1700 },
            }),
            choices: [choice()],
        })).toEqual({
            status: 'resolved',
            agentTarget: { kind: 'agent', identity: CLAUDE_IDENTITY },
            modelSelection: {
                v: 1,
                ref: {
                    agentTargetKey: CLAUDE_KEY,
                    providerConnectionId: null,
                    modelId: 'claude-opus-4-8',
                },
                updatedAt: 1700,
            },
        });
    });

    it('keeps a connection-bound model bound to its connection', () => {
        // The canonical ref has a native arm and a connection arm. Dropping the
        // connection would silently start the session on the agent's own model
        // instead of the one the user pays for through that connection.
        expect(resolveTriageAgentSpawnSelection({
            selection: selection({
                model: { modelId: 'gpt-5', providerConnectionId: 'conn-1', updatedAt: 3 },
            }),
            choices: [choice()],
        })).toEqual({
            status: 'resolved',
            agentTarget: { kind: 'agent', identity: CLAUDE_IDENTITY },
            modelSelection: {
                v: 1,
                ref: { agentTargetKey: CLAUDE_KEY, providerConnectionId: 'conn-1', modelId: 'gpt-5' },
                updatedAt: 3,
            },
        });
    });

    it('says a chosen agent is unavailable instead of falling back to another one', () => {
        // The agent was uninstalled or disabled since the user chose it. Quietly
        // starting the session on a different agent would run the user's Fix on
        // a backend they never selected.
        expect(resolveTriageAgentSpawnSelection({
            selection: selection({ agentTargetKey: 'agent:happier.gone/gone' }),
            choices: [choice(), choice({ agentTargetKey: CODEX_KEY })],
        })).toEqual({ status: 'unavailable', agentTargetKey: 'agent:happier.gone/gone' });
    });

    it('says unavailable when nothing is enumerated at all', () => {
        expect(resolveTriageAgentSpawnSelection({
            selection: selection(),
            choices: [],
        })).toEqual({ status: 'unavailable', agentTargetKey: CLAUDE_KEY });
    });
});
