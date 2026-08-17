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
            value: { start: expect.any(Function) },
        }]);
        expect(Object.isFrozen(registration.registrations()[0]?.value)).toBe(true);
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

        await expect(published.value.start({} as never, {} as never))
            .resolves.toEqual({ marker: 'captured' });
        expect(published.value).not.toHaveProperty('unrelated');
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

        await expect(published.value.start({} as never, {} as never))
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
        })).toThrow(/duplicate contribution 'providers\/gateway'/i);
        expect(duplicate.registrations()).toEqual([]);
    });
});
