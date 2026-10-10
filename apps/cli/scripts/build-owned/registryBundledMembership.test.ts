import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import '../../../ui/sources/dev/vitestSetup';

import * as generatedEntries from '../../../ui/sources/agents/registry/generatedBundledPluginEntries';
import { AGENT_IDS as sharedAgentIds } from '@happier-dev/agents';
import { settingsDefaults } from '../../../ui/sources/sync/domains/settings/settings';

// Native haptics are an OS boundary; registry initialization never invokes them.
vi.mock('expo-haptics', () => ({}));

// These are publication data fixtures, not replacements for registry logic.
// Evaluate the real modules against an optional-plugin exclusion without
// rewriting the shared generated files or mocking getAgentCore/behavior.
async function evaluateRegistry<T>(name: string, fixtures: Readonly<Record<string, unknown>>): Promise<T> {
    const moduleUrl = new URL(`../../../ui/sources/agents/registry/${name}.ts`, import.meta.url);
    const source = transpileModule(readFileSync(moduleUrl, 'utf8'), {
        compilerOptions: { module: ModuleKind.CommonJS },
    }).outputText;
    const dependencies = new Map(Object.entries(fixtures));
    const imports = [...new Set([...source.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1]!))];
    await Promise.all(imports.filter((id) => !dependencies.has(id)).map(async (id) => {
        const path = id.startsWith('.') ? new URL(id, moduleUrl).pathname
            : id.startsWith('@/') ? new URL(`../../../ui/sources/${id.slice(2)}`, import.meta.url).pathname : id;
        try {
            dependencies.set(id, await vi.importActual(path));
        } catch (cause) {
            throw new Error(`Cannot load ${name} dependency ${id}`, { cause });
        }
    }));
    const exports = {};
    runInNewContext(source, { exports, require: (id: string) => dependencies.get(id) });
    return exports as T;
}

describe('bundled UI membership', () => {
    it('initializes real registry behavior from available cores while preserving excluded Agent identity', async () => {
        const excludedId: string = 'qwen';
        expect(sharedAgentIds).toContain(excludedId);
        const entries = {
            ...generatedEntries,
            BUNDLED_CANONICAL_AGENTS_CORE: Object.freeze(Object.fromEntries(
                Object.entries(generatedEntries.BUNDLED_CANONICAL_AGENTS_CORE).filter(([id]) => id !== excludedId),
            )),
            BUNDLED_CANONICAL_AGENTS_UI: Object.freeze(Object.fromEntries(
                Object.entries(generatedEntries.BUNDLED_CANONICAL_AGENTS_UI).filter(([id]) => id !== excludedId),
            )),
        };
        const core = await evaluateRegistry<typeof import('../../../ui/sources/agents/registry/registryCore')>('registryCore', {
            './generatedBundledPluginEntries': entries,
        });
        const behavior = await evaluateRegistry<typeof import('../../../ui/sources/agents/registry/registryUiBehavior')>('registryUiBehavior', {
            './registryCore': core,
        });
        expect(core.CANONICAL_AGENT_IDS).toEqual(sharedAgentIds.filter((id) => Object.hasOwn(entries.BUNDLED_CANONICAL_AGENTS_CORE, id)));
        expect(Object.keys(behavior.CANONICAL_AGENTS_UI_BEHAVIOR)).toEqual(core.CANONICAL_AGENT_IDS);
        expect(core.getAgentCore(excludedId)).toBeNull();
        expect(core.isBundledAgentId(excludedId)).toBe(true);
        expect(behavior.resolveAgentUiBehavior(excludedId).newSession?.supportsTranscriptStorageMode?.({
            agentId: excludedId, settings: settingsDefaults, storageMode: 'direct',
        })).toBe(false);
        expect(() => core.getAllAgentProviderOwnedEnvironmentKeys()).not.toThrow();
        expect(core.resolveAgentIdFromCliDetectKey('qwen')).toBeNull();
        const accountScope = { serverId: 'fixture-home', accountId: 'fixture-account' };
        const { publishProjectedAgentUiBehaviorDescriptors, clearProjectedAgentUiBehaviorDescriptors } = await vi.importActual<
            typeof import('../../../ui/sources/agents/registry/agentUiBehaviorProjection')
        >(new URL('../../../ui/sources/agents/registry/agentUiBehaviorProjection.ts', import.meta.url).pathname);
        try {
            publishProjectedAgentUiBehaviorDescriptors({
                accountScope, accountLifetime: { isCurrent: () => true }, machineId: 'fixture-machine',
                descriptorsByAgentId: { [excludedId]: { permissions: { promptProtocol: 'codexDecision' } } },
            });
            expect(behavior.resolveAgentUiBehavior(excludedId, 'fixture-machine', accountScope).permissions?.promptProtocol).toBe('codexDecision');
        } finally {
            clearProjectedAgentUiBehaviorDescriptors();
        }
    });
});
