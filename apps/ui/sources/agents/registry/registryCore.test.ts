import { describe, it, expect } from 'vitest';

import {
    AGENT_IDS as SHARED_AGENT_IDS,
    AGENT_PROVIDER_IDS as SHARED_AGENT_PROVIDER_IDS,
    getAgentCore as getSharedAgentCore,
    getAgentModelConfig,
    getProviderCliInstallGuideUrl,
} from '@happier-dev/agents';

import {
    AGENTS_CORE,
    CANONICAL_AGENTS_CORE,
    CANONICAL_AGENT_IDS,
    resolveAgentIdFromCliDetectKey,
    resolveAgentIdFromConnectedServiceId,
    resolveAgentIdFromFlavor,
    formatAgentLikeIdForDisplay,
    getAgentCore as getUiAgentCore,
    AGENT_IDS,
} from './registryCore';
import { buildAgentToolsUiConfig } from './buildAgentToolsUiConfig';
import { LEGACY_COMPAT_PRIMARY_AGENT_ID } from '@/agents/backendCatalog/legacyCompatAgents';

describe('agents/registryCore', () => {
    it('exposes a stable list of agent ids', () => {
        expect(Array.isArray(AGENT_IDS)).toBe(true);
        expect(AGENT_IDS.length).toBeGreaterThan(0);
        expect([...AGENT_IDS].sort()).toEqual([...SHARED_AGENT_IDS].sort());
        expect([...CANONICAL_AGENT_IDS].sort()).toEqual([...SHARED_AGENT_PROVIDER_IDS].sort());
    });

    it('exports only agent ids that have a UI core config', () => {
        for (const agentId of AGENT_IDS) {
            const core = getUiAgentCore(agentId);
            expect(core.id).toBe(agentId);
            expect(typeof core.cli.detectKey).toBe('string');
        }
    });

    it('keeps legacy compat agent ids out of the canonical UI core registry', () => {
        expect(AGENTS_CORE).not.toHaveProperty(LEGACY_COMPAT_PRIMARY_AGENT_ID);
        expect(CANONICAL_AGENTS_CORE).not.toHaveProperty(LEGACY_COMPAT_PRIMARY_AGENT_ID);
        expect(CANONICAL_AGENT_IDS).not.toContain(LEGACY_COMPAT_PRIMARY_AGENT_ID);
    });

    it('resolves known flavors and aliases to canonical agent ids', () => {
        expect(resolveAgentIdFromFlavor('claude')).toBe('claude');
        expect(resolveAgentIdFromFlavor('codex')).toBe('codex');
        expect(resolveAgentIdFromFlavor('opencode')).toBe('opencode');
        expect(resolveAgentIdFromFlavor('gemini')).toBe('gemini');

        // Common Codex aliases found in persisted session metadata.
        expect(resolveAgentIdFromFlavor('openai')).toBe('codex');
        expect(resolveAgentIdFromFlavor('gpt')).toBe('codex');
    });

    it('returns null for unknown flavor strings', () => {
        expect(resolveAgentIdFromFlavor('unknown')).toBeNull();
        expect(resolveAgentIdFromFlavor('')).toBeNull();
        expect(resolveAgentIdFromFlavor(null)).toBeNull();
        expect(resolveAgentIdFromFlavor(undefined)).toBeNull();
    });

    it('resolves agent ids from cli detect keys and handles malformed values', () => {
        const cases = [
            { detectKey: 'claude', expected: 'claude' },
            { detectKey: 'codex', expected: 'codex' },
            { detectKey: 'opencode', expected: 'opencode' },
            { detectKey: 'kiro-cli', expected: 'kiro' },
            { detectKey: '  ', expected: null },
            { detectKey: 'unknown', expected: null },
            { detectKey: null, expected: null },
            { detectKey: undefined, expected: null },
        ] as const;
        for (const testCase of cases) {
            expect(resolveAgentIdFromCliDetectKey(testCase.detectKey)).toBe(testCase.expected);
        }
    });

    it('resolves connected service ids in a case-insensitive way', () => {
        expect(resolveAgentIdFromConnectedServiceId('anthropic')).toBe('claude');
        expect(resolveAgentIdFromConnectedServiceId('Anthropic')).toBe('claude');
        expect(resolveAgentIdFromConnectedServiceId('claude-subscription')).toBe('claude');
        expect(resolveAgentIdFromConnectedServiceId('openai')).toBe('codex');
        expect(resolveAgentIdFromConnectedServiceId('')).toBeNull();
        expect(resolveAgentIdFromConnectedServiceId(null)).toBeNull();
        expect(resolveAgentIdFromConnectedServiceId(undefined)).toBeNull();
    });

    it('provides core config for known agents', () => {
        const claude = getUiAgentCore('claude');
        expect(claude.id).toBe('claude');
        expect(claude.cli.detectKey).toBeTruthy();
    });

    it('preserves Qwen quiet unknown-tool rendering from the generated projection', () => {
        expect(getUiAgentCore('qwen').toolRendering.hideUnknownToolsByDefault).toBe(true);
    });

    it('provides core config for kilo', () => {
        const kilo = getUiAgentCore('kilo');
        expect(kilo.id).toBe('kilo');
        expect(kilo.cli.detectKey).toBeTruthy();
    });

    it('provides core config for pi', () => {
        const pi = getUiAgentCore('pi');
        expect(pi.id).toBe('pi');
        expect(pi.cli.detectKey).toBeTruthy();
        expect(pi.runtimeInput?.inFlightSteerSupported).toBe(true);
    });

    it('provides core config for ohMyPi', () => {
        const ohMyPi = getUiAgentCore('ohMyPi');
        expect(ohMyPi.id).toBe('ohMyPi');
        expect(ohMyPi.cli.detectKey).toBe('omp');
    });

    it('provides core config for kiro', () => {
        const kiro = getUiAgentCore('kiro');
        expect(kiro.id).toBe('kiro');
        expect(kiro.cli.detectKey).toBe('kiro-cli');
    });

    it('uses generic installer guidance instead of hardcoded package-manager commands', () => {
        for (const agentId of ['codex', 'opencode', 'qwen', 'kilo', 'kiro', 'ohMyPi', 'pi', 'copilot'] as const) {
            const core = getUiAgentCore(agentId);
            expect(core.cli.installBanner.installKind).toBe('ifAvailable');
            expect(core.cli.installBanner.installCommand).toBeUndefined();
        }
    });

    it('uses centralized setup guide URLs for provider install banners', () => {
        for (const agentId of ['claude', 'opencode', 'kimi', 'qwen', 'ohMyPi', 'pi'] as const) {
            expect(getUiAgentCore(agentId).cli.installBanner.guideUrl).toBe(getProviderCliInstallGuideUrl(agentId));
        }
    });

    it('surfaces shared connected-services compatibility from @happier-dev/agents', () => {
        for (const agentId of AGENT_IDS) {
            expect(getUiAgentCore(agentId)).toMatchObject({
                connectedServices: getSharedAgentCore(agentId).connectedServices ?? null,
            });
        }
    });

    it('exposes an explicit UI-only connected service surface separate from capability metadata', () => {
        expect(getUiAgentCore('claude').uiConnectedService).toEqual({
            serviceId: 'anthropic',
            label: 'Claude Code',
            connectRoute: '/(app)/settings/connect/claude',
        });
        expect(getUiAgentCore('opencode').uiConnectedService).toEqual({
            serviceId: null,
            label: 'OpenCode',
            connectRoute: null,
        });
    });

    it('surfaces shared tools delivery config from @happier-dev/agents', () => {
        for (const agentId of ['claude', 'gemini', 'cursor'] as const) {
            const sharedTools = getSharedAgentCore(agentId).tools;
            expect(buildAgentToolsUiConfig({ agentId })).toEqual({
                delivery: sharedTools?.delivery ?? 'unsupported',
                support: sharedTools?.support ?? 'unsupported',
            });
        }
    });

    it('reads model selection config from @happier-dev/agents', () => {
        const claude = getAgentModelConfig('claude');
        expect(claude.supportsSelection).toBe(true);
        expect(claude.nonAcpApplyScope).toBe('next_prompt');
        expect(claude.supportsFreeform).toBe(true);
        expect(claude.allowedModes.length).toBeGreaterThan(0);

        // ACP backends with supported model probing + overrides
        const codex = getAgentModelConfig('codex');
        expect(codex.supportsSelection).toBe(true);

        const opencode = getAgentModelConfig('opencode');
        expect(opencode.supportsSelection).toBe(true);

        const kilo = getAgentModelConfig('kilo');
        expect(kilo.supportsSelection).toBe(true);

        const kiro = getAgentModelConfig('kiro');
        expect(kiro.supportsSelection).toBe(true);

        const auggie = getAgentModelConfig('auggie');
        expect(auggie.supportsSelection).toBe(true);

        const qwen = getAgentModelConfig('qwen');
        expect(qwen.supportsSelection).toBe(true);

        const kimi = getAgentModelConfig('kimi');
        expect(kimi.supportsSelection).toBe(true);

        const pi = getAgentModelConfig('pi');
        expect(pi.supportsSelection).toBe(true);
    });

    it('formats unknown backend/provider ids into readable fallback display titles', () => {
        expect(formatAgentLikeIdForDisplay('acme.review-backend.v2')).toBe('Acme Review Backend V2');
        expect(formatAgentLikeIdForDisplay('  plugin_backend  ')).toBe('Plugin Backend');
        expect(formatAgentLikeIdForDisplay('')).toBe('Unknown Backend');
    });
});
