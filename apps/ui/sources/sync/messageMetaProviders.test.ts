import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderSettingsPlugin } from '@/agents/providers/_shared/providerSettingsPlugin';
import { getProviderSettingsPlugin } from '@/agents/providers/_registry/providerSettingsRegistry';
import type { MessageMeta } from '@/sync/typesMessageMeta';
import { addProviderMessageMetaExtras } from '@/sync/messageMetaProviders';

vi.mock('@/agents/providers/_registry/providerSettingsRegistry', () => ({
    getProviderSettingsPlugin: vi.fn(),
}));

const getProviderSettingsPluginMock = vi.mocked(getProviderSettingsPlugin);

function buildBaseMeta(): MessageMeta {
    return {
        source: 'ui',
        sentFrom: 'test',
        permissionMode: 'default',
        appendSystemPrompt: 'SYSTEM',
    };
}

function buildPlugin(
    buildOutgoingMessageMetaExtras: ProviderSettingsPlugin['buildOutgoingMessageMetaExtras'],
): ProviderSettingsPlugin {
    return {
        providerId: 'claude',
        title: 'Fake plugin',
        icon: { ionName: 'bug-outline', color: '#000' },
        settingsShape: {},
        settingsDefaults: {},
        uiSections: [],
        buildOutgoingMessageMetaExtras,
    };
}

describe('addProviderMessageMetaExtras', () => {
    beforeEach(() => {
        getProviderSettingsPluginMock.mockReset();
    });

    it('drops non-primitive extras returned by provider plugins', () => {
        getProviderSettingsPluginMock.mockReturnValue(
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
        getProviderSettingsPluginMock.mockReturnValue(
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
        getProviderSettingsPluginMock.mockReturnValue(
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
