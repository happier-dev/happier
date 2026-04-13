import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderSettingsRuntime } from '@/agents/providers/shared/providerSettingsPlugin';
import { getProviderSettingsRuntime } from '@/agents/providers/registry/providerSettingsRegistry';
import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';
import { addProviderMessageMetaExtras } from '@/sync/domains/messages/messageMetaProviders';

vi.mock('@/agents/providers/registry/providerSettingsRegistry', () => ({
    getProviderSettingsRuntime: vi.fn(),
}));

const getProviderSettingsRuntimeMock = vi.mocked(getProviderSettingsRuntime);

function buildBaseMeta(): MessageMeta {
    return {
        source: 'ui',
        sentFrom: 'test',
        permissionMode: 'default',
        appendSystemPrompt: 'SYSTEM',
    };
}

function buildPlugin(
    buildOutgoingMessageMetaExtras: ProviderSettingsRuntime['buildOutgoingMessageMetaExtras'],
): ProviderSettingsRuntime {
    return {
        providerId: 'claude',
        buildOutgoingMessageMetaExtras,
    };
}

describe('addProviderMessageMetaExtras', () => {
    beforeEach(() => {
        getProviderSettingsRuntimeMock.mockReset();
    });

    it('drops non-primitive extras returned by provider plugins', () => {
        getProviderSettingsRuntimeMock.mockReturnValue(
            buildPlugin(() => ({
                ok: true,
                nested: { a: 1 },
                list: [1, 2],
                nil: null,
            })),
        );

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
        getProviderSettingsRuntimeMock.mockReturnValue(
            buildPlugin(() => ({
                __proto__: 'unsafe',
                constructor: 'unsafe',
                prototype: 'unsafe',
                source: 'plugin-source',
                providerEnabled: true,
            })),
        );

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

    it('returns base meta when plugin extra generation throws', () => {
        getProviderSettingsRuntimeMock.mockReturnValue(
            buildPlugin(() => {
                throw new Error('boom');
            }),
        );

        const base = buildBaseMeta();
        const merged = addProviderMessageMetaExtras({
            meta: base,
            agentId: 'claude',
            settings: {},
            session: {},
        });

        expect(merged).toEqual(base);
    });
});
