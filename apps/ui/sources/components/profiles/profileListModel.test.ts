import { describe, expect, it, vi } from 'vitest';
import type { ProfileCompatibilitySummary } from '@/sync/domains/profiles/profileCompatibility';
import { getProfileBackendSubtitle, getProfileSubtitle, type ProfileListStrings } from '@/components/profiles/profileListModel';
import type { AgentId } from '@/agents/catalog/catalog';
import { installProfilesCommonModuleMocks } from './profilesTestHelpers';

installProfilesCommonModuleMocks();

describe('profileListModel', () => {
    const strings: ProfileListStrings = {
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
            kiro: 'Kiro',
            pi: 'Pi',
            copilot: 'Copilot',
        } as Record<AgentId, string>,
    };

    function buildProfile(params: {
        isBuiltIn?: boolean;
        compatibility?: Record<string, boolean>;
        compatibilityByTargetKey?: Record<string, boolean>;
    }): ProfileCompatibilitySummary {
        return {
            isBuiltIn: params.isBuiltIn ?? false,
            compatibility: params.compatibility ?? {},
            compatibilityByTargetKey: params.compatibilityByTargetKey,
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

    it('includes configured ACP backend titles when profile compatibility is target-keyed', () => {
        const profile = {
            ...buildProfile({}),
            compatibilityByTargetKey: {
                'acpBackend:custom-backend': true,
                'agent:claude': false,
            },
        } satisfies ProfileCompatibilitySummary;

        expect(getProfileSubtitle({
            profile,
            enabledAgentIds: ['claude', 'customAcp'],
            backendEntries: [
                { targetKey: 'agent:claude', title: 'Claude' },
                { targetKey: 'acpBackend:custom-backend', title: 'Custom Backend' },
            ],
            strings,
        })).toBe('Custom · Custom Backend');
    });

    it('builds custom subtitle without backend', () => {
        const profile = buildProfile({
            compatibility: { claude: false, codex: false, opencode: false, gemini: false, auggie: false, qwen: false, kimi: false },
        });
        expect(getProfileSubtitle({ profile, enabledAgentIds: ['claude', 'codex', 'gemini'], strings })).toBe('Custom');
    });
});
