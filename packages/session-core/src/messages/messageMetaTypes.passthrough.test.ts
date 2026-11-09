import { describe, expect, it } from 'vitest';

import { MessageMetaSchema } from "./messageMetaTypes.js";
import { rawRecordSchema } from '../raw/schemas.js';
import { TranscriptRawRecordV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { SessionInputAuthoritySchema, SessionInputRequestSchema, readSessionInputAuthority } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { normalizeRawMessage } from '../raw/normalize.js';

describe('stored MessageMetaSchema', () => {
    it.each(['finished', 'failed_or_stopped'] as const)('retains historical %s Follow authority through the real raw reader and normalization', kind => {
        // Redacted retained shape: LIVEWAVE3's seven decrypted 2026-10-23/24
        // rows fail at meta.happierInputAuthorityV1.followDeliveryV1.event.
        const authority = {
            v: 1, producer: 'sessionAction', caller: { kind: 'host' },
            permission: { admittedPermissionCeiling: 'default' },
            followDeliveryV1: { v: 1, delivery: 'wake', original: {
                sourceSessionId: 'source', sourceMessage: { localId: 'terminal', seq: 7 },
            }, event: { kind } },
        };
        const raw = { role: 'user', content: { type: 'text', text: 'redacted retained notice' },
            meta: { happierInputAuthorityV1: authority } };
        const parsed = rawRecordSchema.safeParse(raw);
        expect(parsed.success).toBe(true);
        expect(TranscriptRawRecordV1Schema.safeParse(raw).success).toBe(true);
        const normalized = normalizeRawMessage('historical', null, 1, raw, { seq: 1, messageRole: 'user' });
        expect(normalized?.role).toBe('user');
        expect(normalized?.meta?.happierInputAuthorityV1).toEqual(authority);
        expect(readSessionInputAuthority(raw.meta, 'stored')).toEqual(authority);
        expect(readSessionInputAuthority(raw.meta)).toBeNull();
        expect(SessionInputAuthoritySchema.safeParse(authority).success).toBe(false);
        expect(SessionInputRequestSchema.safeParse({ ...authority, permission: {} }).success).toBe(false);

        for (const invalid of [
            { ...authority, permission: { admittedPermissionCeiling: 'unknown' } },
            { ...authority, producer: 'happierApp' },
            { ...authority, sourceSession: { sourceSessionId: 'other', sourceTurnId: 'turn', via: 'action' } },
            { ...authority, followDeliveryV1: { ...authority.followDeliveryV1, original: {
                ...authority.followDeliveryV1.original, sourceMessage: { localId: 'terminal', seq: 0 },
            } } },
        ]) expect(rawRecordSchema.safeParse({ ...raw, meta: { happierInputAuthorityV1: invalid } }).success).toBe(false);
        expect(rawRecordSchema.safeParse({ ...raw, meta: { ...raw.meta,
            happierInputRequestV1: { v: 1, producer: 'happierApp', permission: {} },
        } }).success).toBe(false);
    });

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
            // The structured-input owner preserves inert additive envelope fields.
            happierStructuredInputV1: { v: 1, vendorPluginMentions: [{ vendorPluginRef: 'plugin' }], futureStructuredField: true },
        });
        expect(TranscriptRawRecordV1Schema.parse(stored).meta).toEqual(parsed.meta);
    });

    it('keeps the saved SCM publication receipt that sits beside its result envelope', () => {
        const scmResultUpdate = { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change: 'created' }] };
        const parsed = MessageMetaSchema.parse({ source: 'cli', happier: { kind: 'scm_diff_summary.v1', payload: { success: true } }, scmResultUpdate });

        expect(parsed.scmResultUpdate).toEqual(scmResultUpdate);
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
