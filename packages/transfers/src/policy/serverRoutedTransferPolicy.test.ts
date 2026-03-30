import { describe, expect, it } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';

import {
    isServerRoutedTransferOverSizeLimit,
    resolveServerRoutedTransferMaxBytesFromEnv,
    resolveServerRoutedTransferMaxBytesFromFeatures,
} from './serverRoutedTransferPolicy';

describe('serverRoutedTransferPolicy', () => {
    it('normalizes the env max-bytes value', () => {
        expect(resolveServerRoutedTransferMaxBytesFromEnv({})).toBe(2 * 1024 * 1024 * 1024);
        expect(resolveServerRoutedTransferMaxBytesFromEnv({
            HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: '42.9',
        })).toBe(42);
    });

    it('reads the max-bytes value from server capabilities', () => {
        const features: FeaturesResponse = {
            features: {
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: true,
                        directPeer: {
                            enabled: true,
                        },
                        serverRouted: {
                            enabled: true,
                        },
                    },
                },
            },
            capabilities: {
                machines: {
                    transfer: {
                        serverRouted: {
                            maxBytes: 128,
                        },
                    },
                },
            },
        };

        expect(resolveServerRoutedTransferMaxBytesFromFeatures(features)).toBe(128);
    });

    it('detects when a payload exceeds the configured size limit', () => {
        expect(isServerRoutedTransferOverSizeLimit(129, 128)).toBe(true);
        expect(isServerRoutedTransferOverSizeLimit(128, 128)).toBe(false);
        expect(isServerRoutedTransferOverSizeLimit(128, null)).toBe(false);
    });
});
