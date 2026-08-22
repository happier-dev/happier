import { describe, expect, it, vi } from 'vitest';

import type {
    PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type {
    PromptAssetAdapter,
    PromptAssetMutationResult,
    PromptAssetReadResult,
} from '@happier-dev/plugin-sdk/resources';

import { createTargetPromptAssetAdapterRegistry } from './targetPromptAssets';

type PromptAssetTypeDescriptor = PromptAssetAdapter['descriptor'];

const descriptor = Object.freeze({
    id: 'acme.skill',
    providerId: 'acme',
    title: 'Acme skills',
    description: 'Acme SKILL.md bundles.',
    libraryKind: 'bundle' as const,
    supportsScope: { user: true, project: true },
    supportsFiles: true,
    formatId: 'skill_md_v1',
    defaultRoots: [],
    capabilities: { supportsCatalogInstall: true },
} satisfies PromptAssetTypeDescriptor);

const readFailure = Object.freeze({
    ok: false as const,
    errorCode: 'unsupported' as const,
    error: 'fixture',
}) satisfies PromptAssetReadResult;
const mutationFailure = readFailure satisfies PromptAssetMutationResult;

function createFixture(params?: Readonly<{
    adapter?: PromptAssetAdapter;
    advertisedDescriptor?: PromptAssetTypeDescriptor;
}>) {
    const observedSignals: AbortSignal[] = [];
    const observe = (options?: PluginCancellationOptions) => {
        if (!options?.signal) throw new Error('Expected composed cancellation signal');
        observedSignals.push(options.signal);
    };
    const adapter = params?.adapter ?? Object.freeze({
        descriptor,
        discover: vi.fn(async (_request, options) => {
            observe(options);
            return Object.freeze([]);
        }),
        read: vi.fn(async (_request, options) => {
            observe(options);
            return readFailure;
        }),
        writeDoc: vi.fn(async (_request, options) => {
            observe(options);
            return mutationFailure;
        }),
        writeBundle: vi.fn(async (_request, options) => {
            observe(options);
            return mutationFailure;
        }),
        delete: vi.fn(async (_request, options) => {
            observe(options);
            return mutationFailure;
        }),
    } satisfies PromptAssetAdapter);
    const retirement = new AbortController();
    let current = true;
    const projection = createTargetPromptAssetAdapterRegistry({
        generation: 7,
        promptAssets: [{
            pluginId: 'acme.prompts',
            localId: 'external-skills',
            adapterDescriptor: params?.advertisedDescriptor ?? descriptor,
        }],
        targetRegistrations: [{
            pluginId: 'acme.prompts',
            generation: '7',
            registration: {
                family: 'promptAssets',
                localId: 'external-skills',
                value: adapter,
            },
        }],
        resolveGenerationLifecycle: () => ({
            isCurrent: () => current,
            retirementSignal: retirement.signal,
        }),
    });
    return {
        adapter,
        observedSignals,
        registry: projection.adapters,
        diagnosticsByPluginId: projection.diagnosticsByPluginId,
        retire(reason: unknown = new Error('retired')) {
            current = false;
            retirement.abort(reason);
        },
    };
}

describe('target Prompt Asset adapters', () => {
    it('projects discover, read, writeDoc, writeBundle, and delete through the real adapter', async () => {
        const fixture = createFixture();
        const projected = fixture.registry.get(descriptor.id);
        if (!projected) throw new Error('Expected projected Prompt Asset adapter');
        const caller = new AbortController();

        await projected.discover({} as never, { signal: caller.signal });
        await projected.read({} as never, { signal: caller.signal });
        await projected.writeDoc({} as never, { signal: caller.signal });
        await projected.writeBundle({} as never, { signal: caller.signal });
        await projected.delete({} as never, { signal: caller.signal });

        expect(fixture.adapter.discover).toHaveBeenCalledOnce();
        expect(fixture.adapter.read).toHaveBeenCalledOnce();
        expect(fixture.adapter.writeDoc).toHaveBeenCalledOnce();
        expect(fixture.adapter.writeBundle).toHaveBeenCalledOnce();
        expect(fixture.adapter.delete).toHaveBeenCalledOnce();
        expect(fixture.observedSignals).toHaveLength(5);
        expect(fixture.observedSignals.every((signal) => signal !== caller.signal)).toBe(true);
    });

    it('composes caller cancellation into an in-flight adapter operation', async () => {
        let observedSignal: AbortSignal | undefined;
        const adapter = Object.freeze({
            descriptor,
            async discover(_request, options) {
                observedSignal = options?.signal;
                await new Promise<void>((_resolve, reject) => {
                    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
                });
                return Object.freeze([]);
            },
            async read() { return readFailure; },
            async writeDoc() { return mutationFailure; },
            async writeBundle() { return mutationFailure; },
            async delete() { return mutationFailure; },
        } satisfies PromptAssetAdapter);
        const fixture = createFixture({ adapter });
        const caller = new AbortController();
        const pending = fixture.registry.get(descriptor.id)!.discover({} as never, { signal: caller.signal });

        caller.abort(new Error('caller cancelled'));

        await expect(pending).rejects.toThrow('caller cancelled');
        expect(observedSignal?.aborted).toBe(true);
    });

    it('aborts in-flight work and fences later calls when its plugin generation retires', async () => {
        let observedSignal: AbortSignal | undefined;
        const adapter = Object.freeze({
            descriptor,
            async discover(_request, options) {
                observedSignal = options?.signal;
                await new Promise<void>((_resolve, reject) => {
                    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
                });
                return Object.freeze([]);
            },
            async read() { return readFailure; },
            async writeDoc() { return mutationFailure; },
            async writeBundle() { return mutationFailure; },
            async delete() { return mutationFailure; },
        } satisfies PromptAssetAdapter);
        const fixture = createFixture({ adapter });
        const projected = fixture.registry.get(descriptor.id)!;
        const pending = projected.discover({} as never);

        fixture.retire(new Error('generation retired'));

        await expect(pending).rejects.toThrow('generation retired');
        expect(observedSignal?.aborted).toBe(true);
        await expect(projected.read({} as never)).rejects.toMatchObject({
            code: 'plugin_generation_stale',
        });
    });

    it('refuses a defensive descriptor mismatch before exposing the adapter', () => {
        const fixture = createFixture({
            advertisedDescriptor: { ...descriptor, formatId: 'different_format_v1' },
        });

        expect(fixture.registry.get(descriptor.id)).toBeUndefined();
        expect(fixture.diagnosticsByPluginId['acme.prompts']).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringMatching(/descriptor mismatch/i),
            }),
        ]);
    });

    // P0 regression: one mis-authored Prompt Asset plugin used to throw out of
    // this global projection, emptying the whole adapter registry and taking
    // every correctly-authored adapter with it.
    it('isolates one mis-authored Prompt Asset plugin instead of emptying the registry', () => {
        const goodDescriptor = Object.freeze({ ...descriptor, id: 'good.skill' });
        const badDeclared = Object.freeze({ ...descriptor, id: 'bad.skill' });
        const badRegistered = Object.freeze({ ...descriptor, id: 'bad.skill.typo' });
        const retirement = new AbortController();
        const adapterFor = (adapterDescriptor: PromptAssetTypeDescriptor): PromptAssetAdapter => ({
            descriptor: adapterDescriptor,
            discover: vi.fn(async () => Object.freeze([])),
            read: vi.fn(async () => readFailure),
            writeDoc: vi.fn(async () => mutationFailure),
            writeBundle: vi.fn(async () => mutationFailure),
            delete: vi.fn(async () => mutationFailure),
        });

        const projection = createTargetPromptAssetAdapterRegistry({
            generation: 7,
            promptAssets: [
                { pluginId: 'good.plugin', localId: 'good-skills', adapterDescriptor: goodDescriptor },
                { pluginId: 'bad.plugin', localId: 'bad-skills', adapterDescriptor: badDeclared },
            ],
            targetRegistrations: [{
                pluginId: 'good.plugin',
                generation: '7',
                registration: {
                    family: 'promptAssets',
                    localId: 'good-skills',
                    value: adapterFor(goodDescriptor),
                },
            }, {
                pluginId: 'bad.plugin',
                generation: '7',
                registration: {
                    family: 'promptAssets',
                    localId: 'bad-skills',
                    value: adapterFor(badRegistered),
                },
            }],
            resolveGenerationLifecycle: () => ({
                isCurrent: () => true,
                retirementSignal: retirement.signal,
            }),
        });

        expect([...projection.adapters.keys()]).toEqual(['good.skill']);
        expect(projection.diagnosticsByPluginId['good.plugin']).toBeUndefined();
        expect(projection.diagnosticsByPluginId['bad.plugin']).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringContaining(
                    "descriptor mismatch: declared type 'bad.skill', registered type 'bad.skill.typo'",
                ),
            }),
        ]);
    });

    it('fails one Prompt Asset type closed when two plugins both claim it', () => {
        const shared = Object.freeze({ ...descriptor, id: 'contested.skill' });
        const other = Object.freeze({ ...descriptor, id: 'uncontested.skill' });
        const retirement = new AbortController();
        const adapterFor = (adapterDescriptor: PromptAssetTypeDescriptor): PromptAssetAdapter => ({
            descriptor: adapterDescriptor,
            discover: vi.fn(async () => Object.freeze([])),
            read: vi.fn(async () => readFailure),
            writeDoc: vi.fn(async () => mutationFailure),
            writeBundle: vi.fn(async () => mutationFailure),
            delete: vi.fn(async () => mutationFailure),
        });

        const projection = createTargetPromptAssetAdapterRegistry({
            generation: 7,
            promptAssets: [
                { pluginId: 'first.plugin', localId: 'skills', adapterDescriptor: shared },
                { pluginId: 'second.plugin', localId: 'skills', adapterDescriptor: shared },
                { pluginId: 'third.plugin', localId: 'skills', adapterDescriptor: other },
            ],
            targetRegistrations: [
                'first.plugin',
                'second.plugin',
                'third.plugin',
            ].map((pluginId) => ({
                pluginId,
                generation: '7',
                registration: {
                    family: 'promptAssets' as const,
                    localId: 'skills',
                    value: adapterFor(pluginId === 'third.plugin' ? other : shared),
                },
            })),
            resolveGenerationLifecycle: () => ({
                isCurrent: () => true,
                retirementSignal: retirement.signal,
            }),
        });

        expect([...projection.adapters.keys()]).toEqual(['uncontested.skill']);
        expect(projection.diagnosticsByPluginId['first.plugin']).toHaveLength(1);
        expect(projection.diagnosticsByPluginId['second.plugin']).toHaveLength(1);
        expect(projection.diagnosticsByPluginId['third.plugin']).toBeUndefined();
    });
});
