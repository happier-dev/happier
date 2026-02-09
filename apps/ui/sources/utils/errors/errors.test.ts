import { describe, expect, it } from 'vitest';
import { HappyError } from './errors';

describe('HappyError', () => {
    it('uses a stable error name for debugging', () => {
        const error = new HappyError('boom', true);
        expect(error.name).toBe('HappyError');
    });

    it('keeps retry and classification metadata', () => {
        const error = new HappyError('network down', false, { status: 503, kind: 'network' });
        expect(error.canTryAgain).toBe(false);
        expect(error.status).toBe(503);
        expect(error.kind).toBe('network');
        expect(error).toBeInstanceOf(Error);
    });
});
