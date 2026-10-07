import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';

const machineRpc = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ storage: { getState: () => ({ sessions: {} }) } });
});

// The machine transport is the external daemon boundary; catalog parsing and capability
// response normalization run unchanged beneath it.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async (importOriginal) => {
    const { createServerScopedMachineRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcModuleMock({ importOriginal, overrides: { machineRpcWithServerScope: machineRpc } });
});

const scope = {
    machineId: 'machine-a', serverId: 'server-a', agentId: 'codex',
    backendTarget: { kind: 'backend', backendId: 'codex' },
    capabilityParams: {
        cwd: '/project', profileId: 'profile-a', runtimeKindOverride: 'appServer',
        environmentVariables: { CODEX_HOME: '/custom-codex' },
        connectedServices: { v: 2, bindingsByServiceId: {} },
    },
} as const;

const nativeCatalogs = {
    commands: { supported: true, items: [{ command: 'project-check', description: 'Check project' }] },
    skills: { supported: true, items: [{
        id: 'vendor:codex:project-check', name: 'project-check',
        path: '/project/.agents/skills/project-check/SKILL.md', origin: 'vendor', backendId: 'codex',
    }] },
};

describe('pre-session composer catalog snapshot', () => {
    beforeEach(() => { machineRpc.mockReset(); });

    it('shares a scoped native discovery and retains successful catalogs across query changes', async () => {
        const { createPreflightComposerSuggestionCatalogSource } = await import('./composerSuggestionCatalogs');
        machineRpc.mockResolvedValue({ ok: true, result: nativeCatalogs });
        const load = createPreflightComposerSuggestionCatalogSource(scope);
        expect(machineRpc).not.toHaveBeenCalled();
        const [first, second] = await Promise.all([load(), load()]);
        expect(second).toBe(first);
        expect(await load()).toBe(first);
        expect(first).toEqual({ commands: nativeCatalogs.commands.items, skills: nativeCatalogs.skills.items });
        expect(machineRpc).toHaveBeenCalledTimes(1);
        expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a', serverId: 'server-a',
            payload: { id: 'cli.codex', method: 'probeCatalogs', params: {
                ...scope.capabilityParams, backendTarget: scope.backendTarget,
            } },
        }));
        const changedScope = createPreflightComposerSuggestionCatalogSource({
            ...scope, capabilityParams: { ...scope.capabilityParams, cwd: '/other' },
        });
        await changedScope();
        expect(machineRpc).toHaveBeenCalledTimes(2);
    });

    it('retries a failed transport but retains genuine unsupported discovery for older daemons', async () => {
        const { createPreflightComposerSuggestionCatalogSource } = await import('./composerSuggestionCatalogs');
        machineRpc.mockRejectedValueOnce(new Error('disconnected'));
        machineRpc.mockResolvedValueOnce({ ok: true, result: nativeCatalogs });
        const load = createPreflightComposerSuggestionCatalogSource(scope);
        await expect(load()).rejects.toThrow();
        expect(await load()).toMatchObject({ commands: nativeCatalogs.commands.items });
        machineRpc.mockResolvedValueOnce({ ok: false, error: { code: 'preflight-catalog-unavailable', message: 'provider unavailable' } });
        machineRpc.mockResolvedValueOnce({ ok: true, result: nativeCatalogs });
        const unavailable = createPreflightComposerSuggestionCatalogSource(scope);
        await expect(unavailable()).rejects.toThrow('preflight-catalog-unavailable');
        expect(await unavailable()).toMatchObject({ skills: nativeCatalogs.skills.items });
        machineRpc.mockResolvedValue({ ok: false, error: { code: 'unsupported-method', message: 'old daemon' } });
        const unsupported = createPreflightComposerSuggestionCatalogSource(scope);
        expect(await unsupported()).toEqual({});
        expect(await unsupported()).toEqual({});
        expect(machineRpc).toHaveBeenCalledTimes(5);
    });

    it('discovers native commands and carries a selected native skill into first-input metadata', async () => {
        const { createPreflightComposerSuggestionCatalogSource } = await import('./composerSuggestionCatalogs');
        const { getSuggestions } = await import('./suggestions');
        const { applySuggestion } = await import('./applySuggestion');
        const { buildStructuredInputMetaOverrides, createStructuredInputMentionFromSuggestion } = await import(
            '@/components/sessions/agentInput/structuredInputMentions'
        );
        const opaqueId = ' reviewer ';
        machineRpc.mockResolvedValue({ ok: true, result: {
            ...nativeCatalogs, skills: { supported: true, items: [
                { ...nativeCatalogs.skills.items[0]!, id: opaqueId },
                { ...nativeCatalogs.skills.items[0]!, id: opaqueId.trim() },
            ] },
        } });
        const loadCatalogs = createPreflightComposerSuggestionCatalogSource(scope);
        expect(await getSuggestions(null, '/project', { kinds: ['slashCommand'], loadCatalogs })).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'slashCommand', text: '/project-check' }),
        ]));
        const skills = await getSuggestions(null, '$project', { kinds: ['skill'], loadCatalogs });
        expect(skills).toHaveLength(2);
        expect(skills.map((skill) => skill.structuredInput)).toEqual([
            expect.objectContaining({ id: opaqueId }),
            expect.objectContaining({ id: opaqueId.trim() }),
        ]);
        const skill = skills[0]!;
        const applied = applySuggestion('$project', { start: 8, end: 8 }, skill.text, ['skill']);
        const mention = createStructuredInputMentionFromSuggestion({ suggestion: skill, start: 0 });
        expect(mention).toMatchObject({ id: opaqueId, backendId: 'codex', origin: 'vendor' });
        const meta = buildStructuredInputMetaOverrides({
            text: applied.text, mentions: mention ? [mention] : [],
        });
        expect(meta.happierStructuredInputV1).toMatchObject({
            mentions: [{ kind: 'happier.skill', ref: 'skill:%20reviewer%20', token: '$project-check' }],
            skillMentions: [{ name: 'project-check', origin: 'vendor', path: nativeCatalogs.skills.items[0]!.path }],
        });
        expect(machineRpc).toHaveBeenCalledTimes(1);
        machineRpc.mockRejectedValue(new Error('disconnected'));
        const failedSource = createPreflightComposerSuggestionCatalogSource(scope);
        expect(await getSuggestions(null, '/clear', { kinds: ['slashCommand'], loadCatalogs: failedSource })).toEqual(expect.arrayContaining([
            expect.objectContaining({ text: '/clear' }),
        ]));
    });

    it('shows local commands during cold discovery and offers arriving native commands without another keystroke', async () => {
        const { createPreflightComposerSuggestionCatalogSource } = await import('./composerSuggestionCatalogs');
        const { getSuggestions } = await import('./suggestions');
        const { useActiveSuggestions } = await import('./useActiveSuggestions');
        const pending = createDeferred<unknown>();
        machineRpc.mockReturnValue(pending.promise);
        const load = createPreflightComposerSuggestionCatalogSource(scope);
        const source = load;
        const hook = await renderHook(() => {
            const snapshot = React.useSyncExternalStore(source.subscribe, source.getSnapshot);
            const handler = React.useCallback((query: string, signal: AbortSignal) => getSuggestions(null, query, {
                kinds: ['slashCommand'], loadCatalogs: source.read, signal,
            }), [snapshot]);
            return useActiveSuggestions('/clear', handler);
        });
        try {
            await flushHookEffects();
            expect(hook.getCurrent()[0]).toEqual(expect.arrayContaining([expect.objectContaining({ text: '/clear' })]));
            pending.resolve({ ok: true, result: {
                ...nativeCatalogs, commands: { supported: true, items: [{ command: 'clear-project' }] },
            } });
            await flushHookEffects();
            expect(hook.getCurrent()[0].map((suggestion) => suggestion.text)).toContain('/clear-project');
        } finally {
            pending.resolve({ ok: true, result: nativeCatalogs });
            await hook.unmount();
        }
    });
});
