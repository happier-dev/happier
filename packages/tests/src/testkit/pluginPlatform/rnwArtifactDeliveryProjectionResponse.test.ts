import { describe, expect, it } from 'vitest';

import { parseRnwArtifactDeliveryProjectionDescribeResponse } from './rnwArtifactDeliveryProjectionResponse';

describe('RNW artifact delivery projection describe response', () => {
    it('preserves an error-only daemon response message', () => {
        const message = 'daemon describe handler threw';
        let thrown: unknown = null;

        try {
            parseRnwArtifactDeliveryProjectionDescribeResponse({ error: message });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe(message);
    });

    it('does not treat a generic error field as an error-only daemon response', () => {
        const message = 'generic domain error';
        let thrown: unknown = null;

        try {
            parseRnwArtifactDeliveryProjectionDescribeResponse({
                error: message,
                context: 'not a daemon error envelope',
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).not.toBe(message);
    });
});
