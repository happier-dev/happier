import { describe, expect, it, vi } from 'vitest';

import type { ManagedProviderRuntime } from '../providers/index.js';
import { createPluginRegistrationScope } from './scope.js';

function scope(rights: readonly Readonly<{
    family: 'providers';
    localId: string;
    target: Readonly<{ realm: 'daemon' }>;
}>[] = [{ family: 'providers', localId: 'gateway', target: { realm: 'daemon' } }]) {
    return createPluginRegistrationScope({
        pluginId: 'acme.providers', target: { realm: 'daemon' }, rights,
    });
}

describe('managed Provider registration', () => {
    it('retains the trusted runtime and parser callbacks without arm entitlement policing', async () => {
        class Runtime {
            marker = 'initial';
            async start() { return { marker: this.marker } as never; }
        }
        const runtime = new Runtime();
        const catalog = () => ({ models: [{ id: 'acme/one' }] });
        const registration = createPluginRegistrationScope({
            pluginId: 'acme.providers', target: { realm: 'daemon' }, rights: [{
                family: 'providers', localId: 'gateway', target: { realm: 'daemon' },
                providerArms: { managedRuntime: false, catalogParserIds: [] },
            }],
        });
        registration.api.providers.register('gateway', runtime);
        registration.api.providers.registerCatalogParser('gateway', 'catalog-v1', catalog);
        const [published] = registration.commit();
        if (published?.family !== 'providers') throw new Error('Expected Provider registration');
        expect(published.value.managedRuntime).toBe(runtime);
        expect(published.value.catalogParsers?.['catalog-v1']).toBe(catalog);
        runtime.marker = 'current';
        await expect(published.value.managedRuntime?.start({} as never, {} as never))
            .resolves.toEqual({ marker: 'current' });
    });

    it('publishes a catalog-only Provider without manufacturing a managed runtime', () => {
        const registration = scope();
        const parse = () => ({ models: [{ id: 'acme/one' }] });
        registration.api.providers.registerCatalogParser('gateway', 'catalog-v1', parse);
        const [published] = registration.commit();
        if (published?.family !== 'providers') throw new Error('Expected Provider registration');
        expect(published.value.managedRuntime).toBeUndefined();
        expect(published.value.catalogParsers).toEqual({ 'catalog-v1': parse });
    });

    it('uses the current trusted runtime callback and its original receiver after commit', async () => {
        const registration = scope();
        const runtime = {
            marker: 'current',
            async start() { return { marker: 'initial' } as never; },
        } satisfies ManagedProviderRuntime & { marker: string };
        registration.api.providers.register('gateway', runtime);
        const [published] = registration.commit();
        if (published?.family !== 'providers') throw new Error('Expected Provider registration');
        runtime.start = async function () { return { marker: this.marker } as never; };
        await expect(published.value.managedRuntime?.start({} as never, {} as never))
            .resolves.toEqual({ marker: 'current' });
    });

    it('rejects duplicate parser ids without publishing a partial Provider', () => {
        const registration = scope();
        const parse = () => ({ models: [] });
        registration.api.providers.registerCatalogParser('gateway', 'catalog-v1', parse);
        expect(() => registration.api.providers.registerCatalogParser('gateway', 'catalog-v1', parse))
            .toThrow(/duplicate/i);
        expect(registration.registrations()).toEqual([]);
        expect(() => registration.commit()).toThrow(/failed/i);
    });

    it('keeps manifest identity, family, missing-registration and duplicate-runtime checks', () => {
        const missing = scope();
        expect(() => missing.commit()).toThrow(/missing registration/i);
        expect(missing.registrations()).toEqual([]);
        expect(scope([]).commit()).toEqual([]);
        const runtime = { start: vi.fn() };
        const undeclared = scope([]);
        expect(() => undeclared.api.providers.register('gateway', runtime)).toThrow(/undeclared contribution/i);
        const wrongId = scope();
        expect(() => wrongId.api.providers.register('other', runtime)).toThrow(/undeclared contribution/i);
        const wrongFamily = scope();
        expect(() => wrongFamily.api.actions.register('gateway', async () => ({}))).toThrow(/undeclared contribution/i);
        const duplicate = scope();
        duplicate.api.providers.register('gateway', runtime);
        expect(() => duplicate.api.providers.register('gateway', runtime)).toThrow(/duplicate/i);
        expect(duplicate.registrations()).toEqual([]);
    });
});
