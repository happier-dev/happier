import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createPluginRegistrationScope } from '../host/registration/index.js';

/**
 * Composed EU-4b proof: the manifest contribution catalog is the only place the
 * packaged/dynamic discrimination is decided, and the registration transaction
 * is the only place a producer is bound. Nothing between them re-decides it.
 */
const CONTRIBUTES = Object.freeze({
    resources: [
        { id: 'style-guide', kind: 'asset', path: 'resources/style.md', contentType: 'text/markdown' },
        { id: 'live-status', source: 'dynamic', kind: 'config', contentType: 'application/json' },
    ],
});

function runtime() {
    return Object.freeze({
        read: vi.fn(() => new Uint8Array([1])),
        observe: vi.fn(() => ({ dispose: vi.fn() })),
    });
}

function scope() {
    return createPluginRegistrationScope({
        pluginId: 'acme.resources',
        target: { realm: 'daemon' },
        rights: derivePluginDaemonContributionRegistrationRights(CONTRIBUTES),
    });
}

describe('dynamic resource producer registration', () => {
    it('binds the declared dynamic producer and yields exactly one resources registration', () => {
        const registrationScope = scope();
        const value = runtime();

        registrationScope.api.resources.registerDynamicResource('live-status', value);

        const registrations = registrationScope.commit();
        expect(registrations).toHaveLength(1);
        expect(registrations[0]).toMatchObject({
            family: 'resources',
            localId: 'live-status',
        });
        expect(registrations[0]?.value).toMatchObject({
            read: expect.any(Function),
            observe: expect.any(Function),
        });
    });

    it('captures dynamic Resource callbacks at commit, including prototype receivers', () => {
        class MutableRuntime {
            reads = 0;
            observations = 0;

            read() {
                this.reads += 1;
                return 'captured';
            }

            observe(invalidate: () => void) {
                this.observations += 1;
                invalidate();
                return { dispose() {} };
            }
        }

        const registrationScope = scope();
        const value = new MutableRuntime();
        registrationScope.api.resources.registerDynamicResource('live-status', value);

        const committedRead = vi.fn(() => 'committed');
        const committedObserve = vi.fn((invalidate: () => void) => {
            invalidate();
            return { dispose() {} };
        });
        value.read = committedRead;
        value.observe = committedObserve;

        const [registration] = registrationScope.commit();
        if (registration?.family !== 'resources') {
            throw new Error('Expected the committed dynamic Resource registration');
        }
        const snapshot = registration.value;
        expect(snapshot).not.toBe(value);
        expect(Object.isFrozen(snapshot)).toBe(true);

        value.read = () => 'replacement';
        value.observe = () => ({ dispose() { throw new Error('replacement observe'); } });

        const options = Object.freeze({
            signal: new AbortController().signal,
            context: Object.freeze({ kind: 'global' as const }),
        });
        expect(snapshot.read(options)).toBe('committed');
        let invalidations = 0;
        snapshot.observe(() => { invalidations += 1; }, options).dispose();

        expect(committedRead).toHaveBeenCalledOnce();
        expect(committedObserve).toHaveBeenCalledOnce();
        expect(value.reads).toBe(0);
        expect(value.observations).toBe(0);
        expect(invalidations).toBe(1);
    });

    it.each([
        [{ observe: () => ({ dispose() {} }) }],
        [{ read: () => 'bytes', observe: null }],
    ])('rejects a dynamic Resource runtime with a missing or noncallable required method', (value) => {
        const registrationScope = scope();
        registrationScope.api.resources.registerDynamicResource('live-status', value as never);
        expect(() => registrationScope.commit()).toThrow(/invalid 'resources\/live-status' runtime/i);
        expect(registrationScope.registrations()).toEqual([]);
    });

    it('fails activation when the declared dynamic resource is never registered', () => {
        // Negative control against "derive a right but never require it": the
        // producerless dynamic resource must not reach a committed generation.
        const registrationScope = scope();
        expect(() => registrationScope.commit()).toThrowError(/resources\/live-status/);
    });

    it('refuses to register a packaged resource as a producer', () => {
        // Negative control against "give every resource a right": a packaged
        // resource is package bytes and has no runtime (§8.1).
        const registrationScope = scope();
        expect(() => registrationScope.api.resources.registerDynamicResource('style-guide', runtime()))
            .toThrowError(/undeclared contribution 'resources\/style-guide'/);
    });
});
