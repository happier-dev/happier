import { describe, expect, it } from 'vitest';

import { HostStructuredMessageDescriptorV1Schema } from './structuredMessageDescriptor';

describe('host structured-message descriptors', () => {
    it('accepts JSON enum values in payload schemas', () => {
        const result = HostStructuredMessageDescriptorV1Schema.safeParse({
            id: 'status-card',
            title: 'Status',
            kind: 'acme.preview/status-card.v1',
            payloadSchema: {
                type: 'string',
                enum: ['ready', 'blocked'],
            },
            renderer: 'status',
            fallback: { kind: 'summary', template: '{status}' },
        });

        expect(result.success).toBe(true);
    });

    it('rejects executable values in payload schema enums', () => {
        const result = HostStructuredMessageDescriptorV1Schema.safeParse({
            id: 'status-card',
            title: 'Status',
            kind: 'acme.preview/status-card.v1',
            payloadSchema: {
                type: 'string',
                enum: [() => 'ready'],
            },
            renderer: 'status',
            fallback: { kind: 'summary', template: '{status}' },
        });

        expect(result.success).toBe(false);
    });
});
