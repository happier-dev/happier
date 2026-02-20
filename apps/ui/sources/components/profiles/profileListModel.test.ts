import { describe, expect, it, vi } from 'vitest';
import type { AIBackendProfile } from '@/sync/domains/settings/settings';
import { getProfileBackendSubtitle, getProfileSubtitle } from '@/components/profiles/profileListModel';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('profileListModel', () => {
    const strings = {
        builtInLabel: 'Built-in',
        customLabel: 'Custom',
        agentLabelById: {
            claude: 'Claude',
            codex: 'Codex',
            opencode: 'OpenCode',
            gemini: 'Gemini',
            auggie: 'Auggie',
            qwen: 'Qwen',
            kimi: 'Kimi',
            kilo: 'Kilo',
            pi: 'Pi',
            copilot: 'Copilot',
        },
    };

    function buildProfile(params: {
        isBuiltIn?: boolean;
        compatibility?: Record<string, boolean>;
    }): Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'> {
        return {
            isBuiltIn: params.isBuiltIn ?? false,
            compatibility: params.compatibility ?? {},
        };
    }

    it('builds backend subtitle for enabled compatible agents', () => {
        const profile = buildProfile({
            compatibility: { claude: true, codex: true, opencode: true, gemini: true, auggie: true, qwen: false, kimi: false },
        });
        expect(getProfileBackendSubtitle({ profile, enabledAgentIds: ['claude', 'codex'], strings })).toBe('Claude • Codex');
    });

    it('skips disabled agents even if compatible', () => {
        const profile = buildProfile({
            compatibility: { claude: true, codex: true, opencode: true, gemini: true, auggie: true, qwen: false, kimi: false },
        });
        expect(getProfileBackendSubtitle({ profile, enabledAgentIds: ['claude', 'gemini'], strings })).toBe('Claude • Gemini');
    });

    it('returns empty backend subtitle when no enabled compatible agents exist', () => {
        const profile = buildProfile({
            compatibility: { claude: false, codex: false, opencode: false, gemini: false, auggie: false, qwen: false, kimi: false, kilo: false },
        });
        expect(getProfileBackendSubtitle({ profile, enabledAgentIds: ['claude', 'codex', 'kilo'], strings })).toBe('');
    });

    it('ignores compatible agents when display labels are missing', () => {
        const profile = buildProfile({
            compatibility: { kilo: true },
        });
        const stringsWithMissingKilo = {
            ...strings,
            agentLabelById: { ...strings.agentLabelById, kilo: '' },
        };
        expect(getProfileBackendSubtitle({ profile, enabledAgentIds: ['kilo'], strings: stringsWithMissingKilo })).toBe('');
    });

    it('builds built-in subtitle with backend', () => {
        const profile = buildProfile({
            isBuiltIn: true,
            compatibility: { claude: true, codex: false, opencode: false, gemini: false, auggie: false, qwen: false, kimi: false },
        });
        expect(getProfileSubtitle({ profile, enabledAgentIds: ['claude', 'codex'], strings })).toBe('Built-in · Claude');
    });

    it('builds custom subtitle without backend', () => {
        const profile = buildProfile({
            compatibility: { claude: false, codex: false, opencode: false, gemini: false, auggie: false, qwen: false, kimi: false },
        });
        expect(getProfileSubtitle({ profile, enabledAgentIds: ['claude', 'codex', 'gemini'], strings })).toBe('Custom');
    });
});
