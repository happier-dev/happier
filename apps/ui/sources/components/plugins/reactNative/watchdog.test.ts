import { describe, expect, it } from 'vitest';

import {
    createPluginReactNativeWatchdog,
    type PluginReactNativeWatchdogPersistence,
    type PluginReactNativeWatchdogSnapshot,
} from './watchdog';

/** A durable store that answers, exactly as the real storage adapter does. */
function createMemoryWatchdogPersistence(): PluginReactNativeWatchdogPersistence {
    let persisted: PluginReactNativeWatchdogSnapshot | null = null;
    return {
        readSnapshot: () => persisted === null
            ? { durability: 'absent' as const }
            : { durability: 'available' as const, snapshot: persisted },
        writeSnapshot: (snapshot) => {
            persisted = snapshot;
            return 'available' as const;
        },
    };
}

const token = {
    mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'preview-destination' },
    },
    renderer: { pluginId: 'acme.preview', localId: 'native-preview' },
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    crashStateEpoch: 4,
} as const;

const composerToken = {
    mount: {
        kind: 'composer',
        contribution: { pluginId: 'acme.composer', localId: 'review' },
        immutableGenerationId: 'composer-generation',
        role: 'attachmentPreview',
    },
    renderer: { pluginId: 'acme.composer', localId: 'review-native-preview' },
    artifactDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    crashStateEpoch: 4,
} as const;

const scopeKey = 'server-a\u0000machine-a\u0000account-a';

describe('Plugin React Native watchdog', () => {
    it('durably keeps one pending occurrence when daemon receipt is lost', () => {
        const persistence = createMemoryWatchdogPersistence();
        const watchdog = createPluginReactNativeWatchdog({
            persistence,
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
        });

        const pending = watchdog.recordFailure({ token, scopeKey, failure: 'render_error' });
        expect(pending).toEqual({
            token,
            failureOccurrenceId: '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
            failure: 'render_error',
        });

        const recovered = createPluginReactNativeWatchdog({
            persistence,
            createFailureOccurrenceId: () => '4bbbf897-0fec-4d4a-8bdf-011a7e2c2a91',
        });
        expect(recovered.readPending({ token, scopeKey })).toEqual([pending]);
    });

    it('keeps concurrent current render failures distinct', () => {
        const occurrenceIds = [
            '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
            '4bbbf897-0fec-4d4a-8bdf-011a7e2c2a91',
        ];
        const watchdog = createPluginReactNativeWatchdog({
            createFailureOccurrenceId: () => occurrenceIds.shift()!,
        });

        const first = watchdog.recordFailure({ token, scopeKey, failure: 'render_error' });
        const second = watchdog.recordFailure({ token, scopeKey, failure: 'render_error' });

        expect(watchdog.readPending({ token, scopeKey })).toEqual([first, second]);
    });

    it('does not let a prior artifact epoch quarantine the current token', () => {
        const watchdog = createPluginReactNativeWatchdog({
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
        });
        watchdog.recordFailure({ token, scopeKey, failure: 'render_error' });

        expect(watchdog.readPending({ token: { ...token, crashStateEpoch: 5 }, scopeKey })).toEqual([]);
    });

    it('preserves Composer crash bindings until a current real failure replaces them', () => {
        const occurrenceIds = [
            '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
            '4bbbf897-0fec-4d4a-8bdf-011a7e2c2a91',
        ];
        const watchdog = createPluginReactNativeWatchdog({
            createFailureOccurrenceId: () => occurrenceIds.shift()!,
        });
        const pending = watchdog.recordFailure({ token: composerToken, scopeKey, failure: 'render_error' });

        watchdog.acknowledgeReportedFailure({
            token: {
                ...composerToken,
                mount: { ...composerToken.mount, immutableGenerationId: 'new-composer-generation' },
            },
            scopeKey,
            failureOccurrenceId: pending.failureOccurrenceId,
        });
        expect(watchdog.readPending({ token: composerToken, scopeKey })).toEqual([pending]);

        const replacementToken = {
            ...composerToken,
            artifactDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
            crashStateEpoch: 5,
        } as const;
        const replacement = watchdog.recordFailure({
            token: replacementToken,
            scopeKey,
            failure: 'render_error',
        });

        expect(watchdog.readPending({ token: composerToken, scopeKey })).toEqual([]);
        expect(watchdog.readPending({ token: replacementToken, scopeKey })).toEqual([replacement]);
    });

    it('cannot speak for a durable quarantine it failed to write', () => {
        const watchdog = createPluginReactNativeWatchdog({
            persistence: {
                readSnapshot: () => ({ durability: 'absent' as const }),
                writeSnapshot: () => 'unavailable' as const,
            },
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
        });
        expect(watchdog.readDurability()).toBe('absent');

        const pending = watchdog.recordFailure({ token, scopeKey, failure: 'render_error' });

        // The refused write leaves the running mount quarantined in memory and
        // retires this UI's claim to durable truth.
        expect(watchdog.readPending({ token, scopeKey })).toEqual([pending]);
        expect(watchdog.readDurability()).toBe('unavailable');
    });

    it('separates a store that holds nothing from a store that cannot answer', () => {
        expect(createPluginReactNativeWatchdog({
            persistence: createMemoryWatchdogPersistence(),
        }).readDurability()).toBe('absent');

        expect(createPluginReactNativeWatchdog({
            persistence: {
                readSnapshot: () => { throw new Error('platform storage unavailable'); },
                writeSnapshot: () => 'available' as const,
            },
        }).readDurability()).toBe('unavailable');

        // Bytes exist but this version cannot account for what they quarantined.
        expect(createPluginReactNativeWatchdog({
            persistence: {
                readSnapshot: () => ({ durability: 'available' as const, snapshot: { v: 2, pending: [] } }),
                writeSnapshot: () => 'available' as const,
            },
        }).readDurability()).toBe('unavailable');

        expect(createPluginReactNativeWatchdog({
            persistence: {
                readSnapshot: () => ({
                    durability: 'available' as const,
                    snapshot: { v: 3, pending: [{ scopeKey, token, failureOccurrenceId: 'not-a-uuid', failure: 'render_error' }] },
                }),
                writeSnapshot: () => 'available' as const,
            },
        }).readDurability()).toBe('unavailable');

        // No local store at all cannot report an absent quarantine either.
        expect(createPluginReactNativeWatchdog({}).readDurability()).toBe('unavailable');
    });
});

