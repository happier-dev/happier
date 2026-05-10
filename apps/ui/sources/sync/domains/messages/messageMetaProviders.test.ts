import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveProviderOutgoingMessageMetaExtras } from '@happier-dev/agents';
import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';
import { addProviderMessageMetaExtras } from '@/sync/domains/messages/messageMetaProviders';

vi.mock('@happier-dev/agents', () => ({
    resolveProviderOutgoingMessageMetaExtras: vi.fn(),
}));

const resolveProviderOutgoingMessageMetaExtrasMock = vi.mocked(resolveProviderOutgoingMessageMetaExtras);

function buildBaseMeta(): MessageMeta {
    return {
        source: 'ui',
        sentFrom: 'test',
        permissionMode: 'default',
        appendSystemPrompt: 'SYSTEM',
    };
}

describe('addProviderMessageMetaExtras', () => {
    beforeEach(() => {
        resolveProviderOutgoingMessageMetaExtrasMock.mockReset();
    });

    it('drops non-primitive extras returned by provider message-meta enrichers', () => {
        resolveProviderOutgoingMessageMetaExtrasMock.mockReturnValue({
            ok: true,
            nested: { a: 1 },
            list: [1, 2],
            nil: null,
        });

        const merged = addProviderMessageMetaExtras({
            meta: buildBaseMeta(),
            agentId: 'claude',
            settings: {},
            session: {},
        });

        expect((merged as Record<string, unknown>).ok).toBe(true);
        expect((merged as Record<string, unknown>).nil).toBeNull();
        expect((merged as Record<string, unknown>).nested).toBeUndefined();
        expect((merged as Record<string, unknown>).list).toBeUndefined();
    });

    it('ignores unsafe keys and does not override existing meta fields', () => {
        resolveProviderOutgoingMessageMetaExtrasMock.mockReturnValue({
            __proto__: 'unsafe',
            constructor: 'unsafe',
            prototype: 'unsafe',
            source: 'plugin-source',
            providerEnabled: true,
        });

        const merged = addProviderMessageMetaExtras({
            meta: buildBaseMeta(),
            agentId: 'claude',
            settings: {},
            session: {},
        });

        expect(merged.source).toBe('ui');
        expect((merged as Record<string, unknown>).providerEnabled).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(merged, 'constructor')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(merged, 'prototype')).toBe(false);
    });

    it('rejects protocol-owned message meta keys from provider extras', () => {
        resolveProviderOutgoingMessageMetaExtrasMock.mockReturnValue({
            model: 'provider-model',
            fallbackModel: 'provider-fallback',
            allowedTools: ['provider-tool'],
            providerEnabled: true,
        });

        const merged = addProviderMessageMetaExtras({
            meta: buildBaseMeta(),
            agentId: 'claude',
            settings: {},
            session: {},
        });

        expect((merged as Record<string, unknown>).model).toBeUndefined();
        expect((merged as Record<string, unknown>).fallbackModel).toBeUndefined();
        expect((merged as Record<string, unknown>).allowedTools).toBeUndefined();
        expect((merged as Record<string, unknown>).providerEnabled).toBe(true);
    });

    it('returns base meta when provider message-meta shaping throws', () => {
        resolveProviderOutgoingMessageMetaExtrasMock.mockImplementation(() => {
            throw new Error('boom');
        });

        const base = buildBaseMeta();
        const merged = addProviderMessageMetaExtras({
            meta: base,
            agentId: 'claude',
            settings: {},
            session: {},
        });

        expect(merged).toEqual(base);
    });

    it('does not consult provider settings runtime behavior when message-meta shaping is unavailable', () => {
        resolveProviderOutgoingMessageMetaExtrasMock.mockImplementation(() => {
            throw new Error('provider settings runtime should not be consulted');
        });

        const base = buildBaseMeta();

        expect(() =>
            addProviderMessageMetaExtras({
                meta: base,
                agentId: 'claude',
                settings: {},
                session: {},
            }),
        ).not.toThrow();
    });

    it('keeps provider leaves out of shared message-meta projection', () => {
        const source = readFileSync(
            fileURLToPath(new URL('./messageMetaProviders.ts', import.meta.url)),
            'utf8',
        );

        expect(source).not.toMatch(/agents\/providers\//);
        expect(source).not.toMatch(/['"]claude['"]/);
    });
});
