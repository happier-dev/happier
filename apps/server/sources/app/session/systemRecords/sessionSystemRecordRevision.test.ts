import { describe, expect, it } from 'vitest';

import { encodeSessionSystemRecordRevision, isSessionSystemRecordRevisionAtLeastAcknowledged } from './sessionSystemRecordRevision';

describe('acknowledged Session record identity', () => {
    it('allows later versions only within the original durable record identity', () => {
        const revision = (id: string, version: number) => encodeSessionSystemRecordRevision({ id, version });
        const acknowledged = revision('original', 2);
        expect(isSessionSystemRecordRevisionAtLeastAcknowledged(revision('original', 2), acknowledged)).toBe(true);
        expect(isSessionSystemRecordRevisionAtLeastAcknowledged(revision('original', 3), acknowledged)).toBe(true);
        expect(isSessionSystemRecordRevisionAtLeastAcknowledged(revision('original', 1), acknowledged)).toBe(false);
        expect(isSessionSystemRecordRevisionAtLeastAcknowledged(revision('replacement', 3), acknowledged)).toBe(false);
        expect(isSessionSystemRecordRevisionAtLeastAcknowledged('ssr1.invalid', acknowledged)).toBe(false);
    });
});
