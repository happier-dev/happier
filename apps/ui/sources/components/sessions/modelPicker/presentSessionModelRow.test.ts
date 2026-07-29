import { createProviderErrorV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { presentProviderModelRow } from '@/providers/models/presentProviderModelRow';

const base = {
    modelId: 'vendor/model-v1',
    name: 'Model V1',
    description: 'Fast model',
    authorization: { authorized: true as const },
    compatibility: {
        result: {
            status: 'verified' as const,
            selectedProtocol: 'openai-responses' as const,
            evidence: { sourceUrls: ['https://docs.example.test/models'], verifiedAt: '2026-07-13' },
        },
        compatibilityFingerprint: 'compatibility:v1:test',
        confirmed: true,
    },
    endpointHealth: 'available' as const,
    stale: false,
    loadState: 'loaded' as const,
    visibility: 'visible' as const,
};

describe('presentProviderModelRow', () => {
    it.each([
        {
            name: 'authorization outranks every lower fact',
            input: {
                ...base,
                authorization: {
                    authorized: false as const,
                    error: createProviderErrorV1('provider_secret_missing'),
                },
                compatibility: {
                    result: { status: 'incompatible' as const, reasons: ['no_compatible_protocol' as const] },
                    compatibilityFingerprint: 'compatibility:v1:test',
                    confirmed: false,
                },
                endpointHealth: 'unreachable' as const,
                stale: true,
                loadState: 'unloaded' as const,
                visibility: 'hidden_current_selection' as const,
            },
            expected: 'authorization',
        },
        {
            name: 'compatibility outranks endpoint and lower facts',
            input: {
                ...base,
                compatibility: {
                    result: { status: 'incompatible' as const, reasons: ['no_compatible_protocol' as const] },
                    compatibilityFingerprint: 'compatibility:v1:test',
                    confirmed: false,
                },
                endpointHealth: 'unreachable' as const,
                stale: true,
                loadState: 'unloaded' as const,
                visibility: 'hidden_current_selection' as const,
            },
            expected: 'compatibility',
        },
        {
            name: 'endpoint health outranks freshness and lower facts',
            input: {
                ...base,
                endpointHealth: 'unreachable' as const,
                stale: true,
                loadState: 'unloaded' as const,
                visibility: 'hidden_current_selection' as const,
            },
            expected: 'endpoint',
        },
        {
            name: 'catalog freshness outranks load and visibility',
            input: {
                ...base,
                stale: true,
                loadState: 'unloaded' as const,
                visibility: 'hidden_current_selection' as const,
            },
            expected: 'catalog',
        },
        {
            name: 'load state outranks visibility',
            input: {
                ...base,
                loadState: 'unloaded' as const,
                visibility: 'hidden_current_selection' as const,
            },
            expected: 'load',
        },
        {
            name: 'visibility is the final primary state',
            input: { ...base, visibility: 'hidden_current_selection' as const },
            expected: 'visibility',
        },
    ])('$name', ({ input, expected }) => {
        expect(presentProviderModelRow(input)).toMatchObject({
            primaryStatus: { kind: expected },
        });
    });

    it('keeps the exact vendor model id visible when a display name and description exist', () => {
        expect(presentProviderModelRow(base)).toMatchObject({
            label: 'Model V1',
            description: expect.stringContaining('vendor/model-v1'),
            primaryStatus: null,
        });
    });
});
