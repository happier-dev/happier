import { describe, expect, it } from 'vitest';

import { createPluginReactNativeWatchdog } from './watchdog';

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
        let persisted: unknown = null;
        const persistence = {
            readSnapshot: () => persisted,
            writeSnapshot: (snapshot: unknown) => { persisted = snapshot; },
        };
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
});
