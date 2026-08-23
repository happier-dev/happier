import { describe, expect, it, vi } from 'vitest';

import type { ManagedProviderRuntime } from '../../providers/index.js';
import { createPluginRegistrationScope } from './scope.js';

function scope(rights: readonly Readonly<{
    family: 'providers';
    localId: string;
    target: Readonly<{ realm: 'daemon' }>;
}>[] = [{
    family: 'providers',
    localId: 'gateway',
    target: { realm: 'daemon' },
}]) {
    return createPluginRegistrationScope({
        pluginId: 'acme.providers',
        target: { realm: 'daemon' },
        rights,
    });
}

describe('managed Provider registration', () => {
    it('snapshots one exact cold managed runtime', () => {
        const registration = scope();
        const start = vi.fn<ManagedProviderRuntime['start']>();

        registration.api.providers.register('gateway', { start });

        expect(registration.commit()).toMatchObject([{
            family: 'providers',
            localId: 'gateway',
            value: { managedRuntime: { start: expect.any(Function) } },
        }]);
        expect(Object.isFrozen(registration.registrations()[0]?.value)).toBe(true);
    });

    it('publishes a contributed catalog format alongside the managed runtime', () => {
        const registration = scope();
        const start = vi.fn<ManagedProviderRuntime['start']>();
        const parse = vi.fn(() => ({ models: [{ id: 'acme/one' }] }));

        registration.api.providers.register('gateway', { start });
        registration.api.providers.registerCatalogParser('gateway', 'acme-catalog-v3', parse);

        const [published] = registration.commit();
        if (published?.family !== 'providers') {
            throw new Error('Expected committed Provider registration');
        }
        expect(published.value.managedRuntime?.start).toEqual(expect.any(Function));
        expect(published.value.catalogParsers?.['acme-catalog-v3']).toBe(parse);
        expect(Object.isFrozen(published.value.catalogParsers)).toBe(true);
    });

    it('publishes a catalog format for a Provider that declares no managed runtime', () => {
        const registration = scope();
        const parse = vi.fn(() => ({ models: [{ id: 'acme/one' }] }));

        registration.api.providers.registerCatalogParser('gateway', 'acme-catalog-v3', parse);

        const [published] = registration.commit();
        if (published?.family !== 'providers') {
            throw new Error('Expected committed Provider registration');
        }
        expect(published.value.managedRuntime).toBeUndefined();
        expect(published.value.catalogParsers).toEqual({ 'acme-catalog-v3': parse });
    });

    it('rejects duplicate, undeclared, and noncallable catalog format registrations', () => {
        const duplicate = scope();
        const parse = vi.fn(() => ({ models: [] }));
        duplicate.api.providers.registerCatalogParser('gateway', 'acme-catalog-v3', parse);
        expect(() => duplicate.api.providers.registerCatalogParser('gateway', 'acme-catalog-v3', parse))
            .toThrow(/duplicate catalog format 'acme-catalog-v3'/i);

        const undeclared = scope();
        expect(() => undeclared.api.providers.registerCatalogParser('other', 'acme-catalog-v3', parse))
            .toThrow(/undeclared contribution 'providers\/other'/i);

        const noncallable = scope();
        noncallable.api.providers.registerCatalogParser(
            'gateway',
            'acme-catalog-v3',
            null as unknown as typeof parse,
        );
        expect(() => noncallable.commit()).toThrow(/invalid 'providers\/gateway' runtime/i);
    });

    it('rejects a missing or noncallable public start operation before publication', () => {
        const registration = scope();

        registration.api.providers.register('gateway', {
            start: null,
        } as unknown as ManagedProviderRuntime);
        expect(() => registration.commit()).toThrow(/invalid 'providers\/gateway' runtime/i);
        expect(registration.registrations()).toEqual([]);
    });

    it('captures class methods and ignores unrelated runtime fields', async () => {
        class Runtime {
            readonly marker = 'captured';
            readonly unrelated = true;

            async start() {
                return { marker: this.marker } as never;
            }
        }
        const registration = scope();
        const runtime = new Runtime();

        registration.api.providers.register('gateway', runtime as ManagedProviderRuntime);
        const [published] = registration.commit();
        if (published?.family !== 'providers') {
            throw new Error('Expected committed managed Provider registration');
        }

        await expect(published.value.managedRuntime?.start({} as never, {} as never))
            .resolves.toEqual({ marker: 'captured' });
        expect(published.value.managedRuntime).not.toHaveProperty('unrelated');
    });

    it('captures the runtime method and its author receiver at commit', async () => {
        const registration = scope();
        const replacementStart = vi.fn<ManagedProviderRuntime['start']>();
        const authorState = new WeakMap<object, string>();
        const runtime: ManagedProviderRuntime = {
            async start() {
                return { marker: authorState.get(this) } as never;
            },
        };
        authorState.set(runtime, 'captured');

        registration.api.providers.register('gateway', runtime);
        const committedStart = vi.fn(async function (this: object) {
            return { marker: authorState.get(this) } as never;
        });
        runtime.start = committedStart;

        const [published] = registration.commit();
        if (published?.family !== 'providers') {
            throw new Error('Expected committed managed Provider registration');
        }
        runtime.start = replacementStart;

        await expect(published.value.managedRuntime?.start({} as never, {} as never))
            .resolves.toEqual({ marker: 'captured' });
        expect(committedStart).toHaveBeenCalledOnce();
        expect(replacementStart).not.toHaveBeenCalled();
        expect(Object.isFrozen(runtime)).toBe(false);
    });

    it('fails missing, extra, wrong-id, and duplicate registrations before publication', () => {
        const missing = scope();
        expect(() => missing.commit()).toThrow(/missing registration 'providers\/gateway'/i);
        expect(missing.registrations()).toEqual([]);

        const descriptorOnly = scope([]);
        expect(descriptorOnly.commit()).toEqual([]);

        const extra = scope([]);
        expect(() => extra.api.providers.register('gateway', {
            start: vi.fn(),
        })).toThrow(/undeclared contribution 'providers\/gateway'/i);
        expect(extra.registrations()).toEqual([]);

        const wrongId = scope();
        expect(() => wrongId.api.providers.register('other', {
            start: vi.fn(),
        })).toThrow(/undeclared contribution 'providers\/other'/i);
        expect(wrongId.registrations()).toEqual([]);

        const duplicate = scope();
        duplicate.api.providers.register('gateway', { start: vi.fn() });
        expect(() => duplicate.api.providers.register('gateway', {
            start: vi.fn(),
        })).toThrow(/duplicate managed Provider runtime for Provider 'gateway'/i);
        expect(duplicate.registrations()).toEqual([]);
    });
});

describe('declared Provider arm correspondence', () => {
    const armScope = (providerArms: Readonly<{
        managedRuntime: boolean;
        catalogParserIds: readonly string[];
    }>) => createPluginRegistrationScope({
        pluginId: 'acme.providers',
        target: { realm: 'daemon' },
        rights: [{
            family: 'providers',
            localId: 'gateway',
            target: { realm: 'daemon' },
            providerArms,
        }],
    });

    it('fails activation when a declared managed runtime arm is never registered', () => {
        const registration = armScope({ managedRuntime: true, catalogParserIds: ['acme-catalog-v3'] });
        registration.api.providers.registerCatalogParser(
            'gateway',
            'acme-catalog-v3',
            vi.fn(() => ({ models: [] })),
        );

        expect(() => registration.commit())
            .toThrow(/missing managed Provider runtime for 'providers\/gateway'/i);
        expect(registration.registrations()).toEqual([]);
    });

    it('fails activation when a declared catalog format arm is never registered', () => {
        const registration = armScope({ managedRuntime: true, catalogParserIds: ['acme-catalog-v3'] });
        registration.api.providers.register('gateway', { start: vi.fn() });

        expect(() => registration.commit())
            .toThrow(/does not implement declared Provider catalog formats for 'providers\/gateway'/i);
        expect(registration.registrations()).toEqual([]);
    });

    it('fails activation on an undeclared managed runtime or catalog format', () => {
        const extraRuntime = armScope({ managedRuntime: false, catalogParserIds: ['acme-catalog-v3'] });
        extraRuntime.api.providers.register('gateway', { start: vi.fn() });
        extraRuntime.api.providers.registerCatalogParser('gateway', 'acme-catalog-v3', vi.fn(() => ({ models: [] })));
        expect(() => extraRuntime.commit())
            .toThrow(/registered an undeclared managed Provider runtime for 'providers\/gateway'/i);

        const extraFormat = armScope({ managedRuntime: true, catalogParserIds: [] });
        extraFormat.api.providers.register('gateway', { start: vi.fn() });
        extraFormat.api.providers.registerCatalogParser('gateway', 'other-format', vi.fn(() => ({ models: [] })));
        expect(() => extraFormat.commit())
            .toThrow(/does not implement declared Provider catalog formats for 'providers\/gateway'/i);
    });

    it('commits the complete declared composite', () => {
        const registration = armScope({ managedRuntime: true, catalogParserIds: ['acme-catalog-v3'] });
        const parse = vi.fn(() => ({ models: [] }));
        registration.api.providers.register('gateway', { start: vi.fn() });
        registration.api.providers.registerCatalogParser('gateway', 'acme-catalog-v3', parse);

        const [published] = registration.commit();
        if (published?.family !== 'providers') throw new Error('Expected committed Provider registration');
        expect(published.value.managedRuntime?.start).toEqual(expect.any(Function));
        expect(published.value.catalogParsers?.['acme-catalog-v3']).toBe(parse);
    });
});
