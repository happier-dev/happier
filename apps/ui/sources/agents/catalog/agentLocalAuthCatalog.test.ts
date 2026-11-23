import { describe, expect, it } from 'vitest';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { getProviderCliInstallGuideUrl } from '@happier-dev/agents';

import { getAgentLocalAuthPlugin, readAgentSignInDeviceCode } from '@/agents/catalog/localAuth/agentLocalAuthCatalog';

describe('provider local auth registry', () => {
    it.each([
        ['codex', 'copilot', '2. Enter this one-time code (expires in 15 minutes)\r\n   \u001b[1mAB12-CD34\u001b[0m\r\n'],
        ['copilot', 'codex', '! First copy your one-time code: AB12-CD34\r\n'],
        ['copilot', 'codex', '! One-time code (AB12-CD34) copied to clipboard\n'],
    ] as const)('recognizes the complete %s prompt for its catalog identity only', (agentId, otherAgentId, output) => {
        const qualifiedId = buildQualifiedPluginContributionKey(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId]);
        expect(readAgentSignInDeviceCode(agentId, output)).toBe('AB12-CD34');
        expect(readAgentSignInDeviceCode(qualifiedId, output)).toBe('AB12-CD34');
        expect(readAgentSignInDeviceCode(agentId, output.trimEnd())).toBeNull();
        expect(readAgentSignInDeviceCode(otherAgentId, output)).toBeNull();
        expect(readAgentSignInDeviceCode(`other-plugin/${agentId}`, output)).toBeNull();
    });

    it('covers every canonical Agent with an explicit local auth plugin', () => {
        const agentIds = [...CANONICAL_AGENT_IDS];
        expect(new Set(agentIds.map((agentId) => getAgentLocalAuthPlugin(agentId as Parameters<typeof getAgentLocalAuthPlugin>[0])?.agentId ?? null))).toEqual(new Set(agentIds));
    });

    it('returns the declared Claude login launch for daemon execution', () => {
        const plugin = getAgentLocalAuthPlugin('claude');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/claude' }) ?? null;

        expect(launch).toEqual({
            launch: { kind: 'agent_login', agentId: 'claude', launchId: 'primary' },
        });
    });

    it('returns the declared Codex login launch for daemon execution', () => {
        const plugin = getAgentLocalAuthPlugin('codex');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/codex' }) ?? null;

        expect(launch).toEqual({
            launch: { kind: 'agent_login', agentId: 'codex', launchId: 'primary' },
        });
    });

    it('returns the declared Copilot login launch for daemon execution', () => {
        const plugin = getAgentLocalAuthPlugin('copilot');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/copilot' }) ?? null;

        expect(launch).toEqual({
            launch: { kind: 'agent_login', agentId: 'copilot', launchId: 'primary' },
        });
    });

    it('returns the declared Kilo login launch for daemon execution', () => {
        const plugin = getAgentLocalAuthPlugin('kilo');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/kilo' }) ?? null;

        expect(launch).toEqual({
            launch: { kind: 'agent_login', agentId: 'kilo', launchId: 'primary' },
        });
    });

    it('returns the declared Kiro login launch for daemon execution', () => {
        const plugin = getAgentLocalAuthPlugin('kiro');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/kiro-cli' }) ?? null;

        expect(launch).toEqual({
            launch: { kind: 'agent_login', agentId: 'kiro', launchId: 'primary' },
        });
    });

    it('uses centralized provider setup guide URLs for local auth plugins', () => {
        for (const agentId of ['claude', 'codex', 'opencode', 'kiro', 'copilot'] as const) {
            expect(getAgentLocalAuthPlugin(agentId)?.docsUrl ?? null).toBe(getProviderCliInstallGuideUrl(agentId));
        }
    });

    it('leaves runtime wrapper resolution to the daemon instead of constructing a shell command', () => {
        const plugin = getAgentLocalAuthPlugin('codex');
        const launch = plugin?.buildLoginLaunch?.({
            resolvedPath: '/opt/tools/fake-codex.js',
            resolvedCommand: `'bun' '/opt/tools/fake-codex.js'`,
            platform: 'darwin',
        }) ?? null;

        expect(launch).toEqual({
            launch: { kind: 'agent_login', agentId: 'codex', launchId: 'primary' },
        });
    });

    it('does not interpolate a local CLI path into the daemon login request', () => {
        const plugin = getAgentLocalAuthPlugin('codex');
        const launch = plugin?.buildLoginLaunch?.({
            resolvedPath: '/Applications/Codex App/bin/codex',
            resolvedCommand: null,
            platform: 'darwin',
        }) ?? null;

        expect(launch).toEqual({
            launch: { kind: 'agent_login', agentId: 'codex', launchId: 'primary' },
        });
    });
});
