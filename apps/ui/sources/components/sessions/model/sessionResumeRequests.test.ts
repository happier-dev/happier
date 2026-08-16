import { describe, expect, it } from 'vitest';

import { emitSessionResumeRequest } from './sessionResumeRequests';

describe('sessionResumeRequests', () => {
    it('rejects when the requested session has no registered resume listener', async () => {
        await expect(emitSessionResumeRequest('session-without-listener')).rejects.toThrow();
    });
});
