import { describe, expect, it, vi } from 'vitest';

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'kiro'],
    getAgentCore: (agentId: string) => ({
        cli: {
            detectKey: ({
                claude: 'claude',
                codex: 'codex',
                kiro: 'kiro-cli',
            } as Record<string, string>)[agentId] ?? agentId,
        },
    }),
}));

const { CAPABILITIES_REQUEST_MACHINE_DETAILS } = await import('./requests');

describe('CAPABILITIES_REQUEST_MACHINE_DETAILS', () => {
    it('excludes Kiro from automatic CLI login-status overrides', () => {
        const overrides = CAPABILITIES_REQUEST_MACHINE_DETAILS.overrides ?? {};

        expect(overrides['cli.codex']).toMatchObject({
            params: {
                includeLoginStatus: true,
            },
        });
        expect(overrides['cli.kiro-cli']).toBeUndefined();
    });
});
