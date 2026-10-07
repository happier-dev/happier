import { describe, expect, it } from 'vitest';

import { MessageMetaSchema } from "./messageMetaTypes.js";
import { rawRecordSchema } from '../raw/schemas.js';
import { TranscriptRawRecordV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';

describe('stored MessageMetaSchema', () => {
    it('projects known message sidecars without dropping opaque provider payloads', () => {
        const stored = {
            role: 'agent',
            content: { type: 'acp', agentId: 'codex', data: {
                type: 'message', message: 'text', futureProviderField: { value: true },
            } },
            meta: {
                source: 'runtime',
                sidechainId: 'sidechain',
                runtimeEventKind: 'message',
                happierStreamSegmentV1: {
                    v: 1, segmentKind: 'assistant', segmentLocalId: 'segment',
                    segmentState: 'streaming', startedAtMs: 10, updatedAtMs: 20, futureSegmentField: true,
                },
                happier: {
                    kind: 'plugin_output.v1', payload: { futurePayloadField: { value: true } },
                    resources: [{ pluginId: 'example.plugin', localId: 'resource', futureResourceField: true }],
                    conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice', futureOriginField: true },
                    futureEnvelopeField: true,
                },
                happierStructuredInputV1: {
                    v: 1, vendorPluginMentions: [{ vendorPluginRef: 'plugin', futureMentionField: true }],
                    futureStructuredField: true,
                },
                futureMetadataField: true,
            },
        };
        const parsed = rawRecordSchema.parse(stored);

        expect(parsed.content).toMatchObject({ data: { futureProviderField: { value: true } } });
        expect(parsed.meta).toEqual({
            source: 'runtime', sidechainId: 'sidechain', runtimeEventKind: 'message',
            happierStreamSegmentV1: {
                v: 1, segmentKind: 'assistant', segmentLocalId: 'segment',
                segmentState: 'streaming', startedAtMs: 10, updatedAtMs: 20,
            },
            happier: {
                kind: 'plugin_output.v1', payload: { futurePayloadField: { value: true } },
                resources: [{ pluginId: 'example.plugin', localId: 'resource' }],
                conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice' },
            },
            happierStructuredInputV1: { v: 1, vendorPluginMentions: [{ vendorPluginRef: 'plugin' }] },
        });
        expect(TranscriptRawRecordV1Schema.parse(stored).meta).toEqual(parsed.meta);
    });

    it('drops unknown and prototype-related stored keys', () => {
        const payload = JSON.parse(
            '{"source":"ui","safeProviderFlag":true,"__proto__":{"polluted":true},"constructor":{"prototype":{"evil":true}},"prototype":{"x":1}}',
        );
        const parsed = MessageMetaSchema.parse(payload);

        expect(parsed).not.toHaveProperty('safeProviderFlag');
        expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(parsed, 'constructor')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(parsed, 'prototype')).toBe(false);

        const merged: Record<string, unknown> = {};
        Object.assign(merged, parsed);
        expect(({} as any).polluted).toBeUndefined();
        expect(({} as any).evil).toBeUndefined();
    });

    it('projects primary and secondary stored media through the same domain schema', () => {
        const media = {
            id: 'media', role: 'output', category: 'generated', mediaKind: 'image', mimeType: 'image/png',
            name: 'image.png', path: '.happier/uploads/generated/image.png', sizeBytes: 42,
            origin: { source: 'provider-generated', futureOriginField: true }, futureMediaField: true,
        };
        const envelope = { kind: 'session_media.v1', payload: { media: [media], futurePayloadField: true } };
        const parsed = MessageMetaSchema.parse({ happier: envelope, happierMedia: envelope });
        const expected = { kind: 'session_media.v1', payload: { media: [{
            id: 'media', role: 'output', category: 'generated', mediaKind: 'image', mimeType: 'image/png',
            name: 'image.png', path: '.happier/uploads/generated/image.png', sizeBytes: 42,
            origin: { source: 'provider-generated' },
        }] } };
        expect(parsed.happier).toEqual(expected);
        expect(parsed.happierMedia).toEqual(expected);
    });

    it('keeps transcript text when an optional source sidecar is not understood', () => {
        const parsed = rawRecordSchema.parse({ role: 'user', content: { type: 'text', text: 'hello' }, meta: {
            happierStructuredInputV1: { v: 2 },
            happierStreamSegmentV1: { v: 2, segmentKind: 'assistant' },
        } });
        expect(parsed.content).toMatchObject({ text: 'hello' });
        expect(parsed.meta?.happierStructuredInputV1).toBeUndefined();
        expect(parsed.meta?.happierStreamSegmentV1).toBeUndefined();
    });
});
