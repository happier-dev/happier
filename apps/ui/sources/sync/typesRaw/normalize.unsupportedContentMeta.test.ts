import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from './normalize';
import { readUnsupportedContentMeta } from '../domains/messages/unsupportedContentMeta';

describe('normalizeRawMessage unsupported-content meta marking', () => {
    it('marks a Zod parse failure for a user record as unparsed-user-message', () => {
        const raw: any = {
            role: 'user',
            // `content.type` outside the known 'output' | 'event' | 'codex' | 'acp' union fails schema validation.
            content: { type: 'totally-unknown-content-type' },
        };

        const normalized = normalizeRawMessage('msg-1', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized) return;
        expect(normalized.role).toBe('user');
        expect(readUnsupportedContentMeta(normalized.meta)?.kind).toBe('unparsed-user-message');
    });

    it('marks a Zod parse failure for an agent record as unparsed-agent-message', () => {
        const raw: any = {
            role: 'agent',
            content: { type: 'totally-unknown-content-type' },
        };

        const normalized = normalizeRawMessage('msg-2', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized) return;
        expect(normalized.role).toBe('agent');
        expect(readUnsupportedContentMeta(normalized.meta)?.kind).toBe('unparsed-agent-message');
    });

    it('marks an unrecognized output payload as unsupported-agent-output, carrying the raw data type', () => {
        const raw: any = {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'some_future_output_type' },
            },
        };

        const normalized = normalizeRawMessage('msg-3', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized) return;
        expect(normalized.role).toBe('agent');
        expect(readUnsupportedContentMeta(normalized.meta)).toEqual({
            kind: 'unsupported-agent-output',
            recordType: 'some_future_output_type',
        });
    });

    it('marks an unrecognized ACP data payload as unsupported-transcript-record, carrying the raw data type', () => {
        const raw: any = {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'some-provider',
                data: { type: 'some_future_acp_type' },
            },
        };

        const normalized = normalizeRawMessage('msg-4', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized) return;
        expect(normalized.role).toBe('agent');
        expect(readUnsupportedContentMeta(normalized.meta)).toEqual({
            kind: 'unsupported-transcript-record',
            recordType: 'some_future_acp_type',
        });
    });
});
