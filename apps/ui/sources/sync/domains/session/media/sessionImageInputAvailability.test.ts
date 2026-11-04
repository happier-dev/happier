import { describe, expect, it } from 'vitest';
import { SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { decideSessionImageInputAvailability, readSessionImageInputAvailability } from './sessionImageInputAvailability';

describe('decideSessionImageInputAvailability', () => {
    it('disables image input when the opened dispatcher explicitly refuses it', () => {
        expect(decideSessionImageInputAvailability({ agentRuntimeCapabilitiesV1: {
            backend: { session: { media: { acceptsImageInput: { supported: false } } } },
        } })).toEqual({ available: false, reason: 'image_input_unsupported' });
    });
    it.each([true, false])('uses the opened dispatcher publication (%s) through owner metadata admission', (supported) => {
        const owner = SessionOwnerMetadataV1Schema.parse({ v: 1, runtime: {
            agentRuntimeCapabilitiesV1: { backend: { session: { media: { acceptsImageInput: { supported } } } } },
        } });
        expect(decideSessionImageInputAvailability(owner.runtime)).toEqual(supported
            ? { available: true }
            : { available: false, reason: 'image_input_unsupported' });
    });

    it.each([null, undefined, {}, { agentRuntimeCapabilitiesV1: {} }])('keeps an unpublished runtime enabled', (metadata) => {
        expect(decideSessionImageInputAvailability(metadata)).toEqual({ available: true });
    });

    it('uses the compact owner decision and the full owner view through one reader', () => {
        const unsupported = { available: false, reason: 'image_input_unsupported' } as const;
        expect(readSessionImageInputAvailability({ imageInputAvailability: unsupported })).toBe(unsupported);
        expect(readSessionImageInputAvailability({ metadataLayoutVersion: 1, ownerMetadataView: {
            agentRuntimeCapabilitiesV1: { backend: { session: { media: { acceptsImageInput: { supported: false } } } } },
        } })).toEqual(unsupported);
    });

    it('enables an unopened composer target even after reading a prior runtime refusal', () => {
        expect(readSessionImageInputAvailability({ metadata: { agentRuntimeCapabilitiesV1: {
            backend: { session: { media: { acceptsImageInput: { supported: false } } } },
        } } })).toEqual({ available: false, reason: 'image_input_unsupported' });
        expect(readSessionImageInputAvailability(null)).toEqual({ available: true });
    });
});
