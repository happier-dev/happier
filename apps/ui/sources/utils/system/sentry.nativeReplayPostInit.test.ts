import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sentryPatchMarker = 'HAPPIER PATCH(sentry-native-replay-postinit-guard)';

const sentryNativeStartFiles = [
    '../../../node_modules/@sentry/react-native/ios/RNSentryStart.m',
    '../../../node_modules/@sentry/react-native/ios/RNSentry.mm',
] as const;

const sentryNativePatchFile = '../../../patches/@sentry+react-native+7.11.0.patch';

function readSentryNativeStartSource(): string {
    for (const relativePath of sentryNativeStartFiles) {
        const sourceUrl = new URL(relativePath, import.meta.url);
        if (existsSync(sourceUrl)) {
            return readFileSync(sourceUrl, 'utf8');
        }
    }

    throw new Error('Expected @sentry/react-native iOS native start source to exist');
}

describe('native Sentry replay initialization patch', () => {
    it('documents the replay postInit guard in the patch file contract', () => {
        const patchSource = readFileSync(new URL(sentryNativePatchFile, import.meta.url), 'utf8');
        const markerIndex = patchSource.indexOf(sentryPatchMarker);
        const guardIndex = patchSource.indexOf('if (isSessionReplayEnabled)', markerIndex);
        const postInitIndex = patchSource.indexOf('[RNSentryReplay postInit]', guardIndex);

        expect(markerIndex).toBeGreaterThan(-1);
        expect(guardIndex).toBeGreaterThan(markerIndex);
        expect(postInitIndex).toBeGreaterThan(guardIndex);
    });

    it('guards replay postInit behind runtime replay enablement', () => {
        const source = readSentryNativeStartSource();
        const postInitIndex = source.indexOf('[RNSentryReplay postInit]');
        expect(postInitIndex).toBeGreaterThan(-1);

        const precedingSource = source.slice(0, postInitIndex);
        const guardIndex = Math.max(
            precedingSource.lastIndexOf('if (isSessionReplayEnabled)'),
            precedingSource.lastIndexOf('if (options.sessionReplay.sessionSampleRate > 0'),
        );
        const methodStartIndex = Math.max(
            precedingSource.lastIndexOf('+ (void)startWithOptions:(SentryOptions *)options'),
            precedingSource.lastIndexOf('RCT_EXPORT_METHOD(initNativeSdk'),
        );

        expect(guardIndex).toBeGreaterThan(methodStartIndex);
        const guardSource = source.slice(guardIndex, postInitIndex);
        expect(guardSource).toMatch(/isSessionReplayEnabled|sessionReplay\.(sessionSampleRate|onErrorSampleRate)/);
    });
});
