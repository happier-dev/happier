import { describe, expect, it } from 'vitest';

describe('live-stream player diagnostics', () => {
    it('projects raw decoder failures to typed diagnostics without leaking sensitive details', async () => {
        const mod = await import('./diagnostics').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createLiveStreamPlayerDiagnostic');
        if (!('createLiveStreamPlayerDiagnostic' in mod)) return;

        expect(mod.createLiveStreamPlayerDiagnostic({
            reasonCode: 'decoder_error',
            message: 'VideoDecoder failed with token=secret-token and grant=abc123',
        })).toEqual({
            reasonCode: 'decoder_error',
        });
    });
});
