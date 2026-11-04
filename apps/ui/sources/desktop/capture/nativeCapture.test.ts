import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPreparedCapturePng } from './nativeCapture';

afterEach(() => vi.unstubAllGlobals());

describe('native capture byte transport', () => {
    it('preserves a prepared-missing refusal instead of reading source bytes', async () => {
        const invoke = vi.fn().mockRejectedValue('prepared_missing');
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        await expect(readPreparedCapturePng('capture-1')).rejects.toMatchObject({ code: 'prepared_missing' });
        expect(invoke).toHaveBeenCalledTimes(1);
    });
});
