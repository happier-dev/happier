import { describe, expect, it } from 'vitest';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';
import { getProviderCliInstallGuideUrl } from '@happier-dev/agents';

import { getAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/agentLocalAuthCatalog';

describe('provider local auth registry', () => {
    it('covers every canonical Agent with an explicit local auth plugin', () => {
        const agentIds = [...CANONICAL_AGENT_IDS];
        expect(new Set(agentIds.map((agentId) => getAgentLocalAuthPlugin(agentId as Parameters<typeof getAgentLocalAuthPlugin>[0])?.agentId ?? null))).toEqual(new Set(agentIds));
    });

    it('returns a Claude launch strategy that starts the CLI and submits /login as terminal input', () => {
        const plugin = getAgentLocalAuthPlugin('claude');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/claude' }) ?? null;

        expect(launch).toEqual({
            initialCommand: '/usr/local/bin/claude',
            initialInput: '/login\r',
        });
    });

    it('returns a Codex launch strategy that runs the direct login command', () => {
        const plugin = getAgentLocalAuthPlugin('codex');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/codex' }) ?? null;

        expect(launch).toEqual({
            initialCommand: '/usr/local/bin/codex login',
        });
    });

    it('returns a Copilot launch strategy that runs the direct login command', () => {
        const plugin = getAgentLocalAuthPlugin('copilot');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/copilot' }) ?? null;

        expect(launch).toEqual({
            initialCommand: '/usr/local/bin/copilot login',
        });
    });

    it('returns a Kilo launch strategy that starts the CLI and submits /connect as terminal input', () => {
        const plugin = getAgentLocalAuthPlugin('kilo');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/kilo' }) ?? null;

        expect(launch).toEqual({
            initialCommand: '/usr/local/bin/kilo',
            initialInput: '/connect\r',
        });
    });

    it('returns a Kiro launch strategy that runs the direct login command', () => {
        const plugin = getAgentLocalAuthPlugin('kiro');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/kiro-cli' }) ?? null;

        expect(launch).toEqual({
            initialCommand: '/usr/local/bin/kiro-cli login',
        });
    });

    it('uses centralized provider setup guide URLs for local auth plugins', () => {
        for (const agentId of ['claude', 'codex', 'opencode', 'kiro', 'copilot'] as const) {
            expect(getAgentLocalAuthPlugin(agentId)?.docsUrl ?? null).toBe(getProviderCliInstallGuideUrl(agentId));
        }
    });

    it('prefers a resolved shell command when the CLI requires a runtime wrapper', () => {
        const plugin = getAgentLocalAuthPlugin('codex');
        const launch = plugin?.buildLoginLaunch?.({
            resolvedPath: '/opt/tools/fake-codex.js',
            resolvedCommand: `'bun' '/opt/tools/fake-codex.js'`,
            platform: 'darwin',
        }) ?? null;

        expect(launch).toEqual({
            initialCommand: `'bun' '/opt/tools/fake-codex.js' login`,
        });
    });

    it('quotes a fallback resolvedPath when the CLI path contains spaces', () => {
        const plugin = getAgentLocalAuthPlugin('codex');
        const launch = plugin?.buildLoginLaunch?.({
            resolvedPath: '/Applications/Codex App/bin/codex',
            resolvedCommand: null,
            platform: 'darwin',
        }) ?? null;

        expect(launch).toEqual({
            initialCommand: `'/Applications/Codex App/bin/codex' login`,
        });
    });
});
