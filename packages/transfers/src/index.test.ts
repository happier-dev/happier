import { describe, expect, it } from 'vitest';

import { SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR } from './index';

describe('transfers package root exports', () => {
    it('exports the canonical server-routed file-too-large error constant', () => {
        expect(SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR).toBe('File exceeds the server-routed transfer size limit');
    });
});
