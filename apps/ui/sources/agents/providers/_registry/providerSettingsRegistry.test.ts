import * as z from 'zod';
import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from '@/agents/catalog/catalog';
import type { ProviderSettingsPlugin } from '@/agents/providers/_shared/providerSettingsPlugin';
import { assertProviderSettingsPluginsValid, getProviderSettingsPlugin } from '@/agents/providers/_registry/providerSettingsRegistry';

function makePlugin(overrides: Partial<ProviderSettingsPlugin>): ProviderSettingsPlugin {
    const base: ProviderSettingsPlugin = {
        providerId: 'claude',
        title: 'Test',
        icon: { ionName: 'bug-outline', color: '#000' },
        settingsShape: { foo: z.string() },
        settingsDefaults: { foo: '' },
        uiSections: [
            {
                id: 'main',
                title: 'Main',
                fields: [{ key: 'foo', kind: 'text', title: 'Foo' }],
            },
        ],
        buildOutgoingMessageMetaExtras: () => ({}),
    };
    return { ...base, ...overrides };
}

describe('assertProviderSettingsPluginsValid', () => {
    it('rejects duplicate provider ids', () => {
        const a = makePlugin({ providerId: 'claude' as any, settingsShape: { a: z.string() }, settingsDefaults: { a: '' } });
        const b = makePlugin({ providerId: 'claude' as any, settingsShape: { b: z.string() }, settingsDefaults: { b: '' } });
        expect(() => assertProviderSettingsPluginsValid([a, b])).toThrow(/duplicate providerId/i);
    });

    it('rejects missing defaults for settingsShape keys', () => {
        const a = makePlugin({
            providerId: 'claude' as any,
            settingsShape: { a: z.string(), b: z.string() },
            settingsDefaults: { a: '' },
        });
        expect(() => assertProviderSettingsPluginsValid([a])).toThrow(/missing defaults/i);
    });

    it('rejects json fields that accept invalid JSON', () => {
        const a = makePlugin({
            providerId: 'claude' as any,
            settingsShape: { jsonData: z.string() },
            settingsDefaults: { jsonData: '' },
            uiSections: [
                {
                    id: 'main',
                    title: 'Main',
                    fields: [{ key: 'jsonData', kind: 'json', title: 'JSON data' }],
                },
            ],
        });
        expect(() => assertProviderSettingsPluginsValid([a])).toThrow(/json/i);
    });
});

describe('getProviderSettingsPlugin', () => {
    it('resolves plugins case-insensitively', () => {
        expect(getProviderSettingsPlugin('CLAUDE' as any)).not.toBeNull();
    });

    it('has a plugin entry for every registered backend', () => {
        for (const agentId of AGENT_IDS) {
            expect(getProviderSettingsPlugin(agentId)).not.toBeNull();
        }
    });
});
