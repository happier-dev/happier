import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from './normalize';
import { RawRecordSchema } from './schemas';

describe('typesRaw output schema (fail-soft)', () => {
    const wrapOutput = (data: Record<string, unknown>) => ({
        role: 'agent',
        content: { type: 'output', data },
    });

    it('filters a message-less assistant row classified as an event', () => {
        const raw = wrapOutput({
            type: 'assistant',
            uuid: 'assistant-api-error',
            isApiErrorMessage: true,
        });

        expect(RawRecordSchema.safeParse(raw).success).toBe(true);
        expect(normalizeRawMessage('msg-api-error', null, 1000, raw, { messageRole: 'event' })).toBeNull();
    });

    it('materializes assistant content when the nested message role is missing', () => {
        const raw = wrapOutput({
            type: 'assistant',
            uuid: 'assistant-missing-role',
            message: { content: [{ type: 'text', text: 'hello' }] },
        });

        const normalized = normalizeRawMessage('msg-missing-role', null, 1000, raw, { messageRole: 'agent' });

        expect(normalized).not.toBeNull();
        if (normalized?.role !== 'agent') throw new Error('expected normalized agent message');
        expect(normalized.content[0]).toMatchObject({ type: 'text', text: 'hello' });
    });

    it('filters a null-content assistant row classified as an event', () => {
        const raw = wrapOutput({
            type: 'assistant',
            uuid: 'assistant-null-content',
            message: { role: 'assistant', content: null },
        });

        expect(RawRecordSchema.safeParse(raw).success).toBe(true);
        expect(normalizeRawMessage('msg-null-content', null, 1000, raw, { messageRole: 'event' })).toBeNull();
    });

    it('keeps an unknown future output visible for an unknown message role', () => {
        const raw = wrapOutput({ type: 'future-output', payload: { nested: true } });

        const normalized = normalizeRawMessage('msg-future', null, 1000, raw, { messageRole: 'unknown' });

        expect(normalized).not.toBeNull();
        expect(normalized?.role).toBe('agent');
    });

    it('materializes assistant string content as a text block (no unsupported placeholder)', () => {
        const raw = wrapOutput({
            type: 'assistant',
            uuid: 'assistant-1',
            message: {
                role: 'assistant',
                model: 'model-x',
                content: 'hello',
            },
        });

        const normalized = normalizeRawMessage('msg-assistant-1', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized) return;
        expect(normalized.role).toBe('agent');
        if (normalized.role !== 'agent') return;
        expect(normalized.content[0]).toEqual(
            expect.objectContaining({
                type: 'text',
                text: 'hello',
            }),
        );
    });

    it('names the unrecognized payload type in the fallback placeholder', () => {
        // Without the type name the placeholder is undiagnosable: new Claude Code record types
        // render as an opaque row with nothing to grep for.
        const raw: any = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'some-future-record',
                    uuid: 'future-1',
                },
            },
        };

        const normalized = normalizeRawMessage('msg-future-1', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized) return;
        expect(normalized.role).toBe('agent');
        if (normalized.role !== 'agent') return;

        const block = normalized.content[0];
        expect(block?.type).toBe('text');
        expect(block?.type === 'text' && block.text).toContain('some-future-record');
    });
});
