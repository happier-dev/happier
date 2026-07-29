import { beforeEach, describe, expect, it, vi } from 'vitest';

const agentsPackageState = vi.hoisted(() => ({
    AGENT_IDS: ['claude', 'codex', 'kiro'],
    CANONICAL_AGENT_IDS: ['claude', 'codex', 'kiro'],
    AGENT_LOCAL_CLI_CONFIG: {
        claude: { detectKey: 'claude' },
        codex: { detectKey: 'codex' },
        kiro: { detectKey: 'kiro-cli' },
    },
    isAgentAuthProbeSafeForBackgroundChecks: (agentId: string) => agentId !== 'kiro',
}));

function resolvePackageDetectKey(agentId: string): string {
    const entry = (agentsPackageState.AGENT_LOCAL_CLI_CONFIG as Record<string, { detectKey: string }>)[agentId];
    return entry?.detectKey ?? agentId;
}

vi.mock('@happier-dev/agents', () => ({
    ...agentsPackageState,
    getAgentLocalCliConfig: (agentId: string) => ({
        agentId,
        detectKey: resolvePackageDetectKey(agentId),
        machineLoginKey: agentId,
        supportKind: 'login_terminal',
        loginLaunch: null,
    }),
    getAgentAuthProbeConfig: (agentId: string) => ({
        agentId,
        binaryNames: [resolvePackageDetectKey(agentId)],
        statusCommand: null,
        parser: 'unknown',
        backgroundChecks: agentsPackageState.isAgentAuthProbeSafeForBackgroundChecks(agentId) ? 'safe' : 'manual_only',
    }),
}));

const { CAPABILITIES_REQUEST_MACHINE_DETAILS } = await import('./requests');

describe('CAPABILITIES_REQUEST_MACHINE_DETAILS', () => {
    beforeEach(() => {
        agentsPackageState.AGENT_LOCAL_CLI_CONFIG.codex.detectKey = 'codex';
        agentsPackageState.AGENT_LOCAL_CLI_CONFIG.kiro.detectKey = 'kiro-cli';
    });

    it('excludes Kiro from automatic CLI login-status overrides', () => {
        const overrides = CAPABILITIES_REQUEST_MACHINE_DETAILS.overrides ?? {};

        expect(overrides['cli.codex']).toMatchObject({
            params: {
                includeLoginStatus: true,
            },
        });
        expect(overrides['cli.kiro-cli']).toBeUndefined();
    });

    it('projects login-status overrides from canonical provider ids even when binary detect keys differ', async () => {
        agentsPackageState.AGENT_LOCAL_CLI_CONFIG.codex.detectKey = 'codex-alt';

        vi.resetModules();
        vi.doMock('@happier-dev/agents', () => ({
            ...agentsPackageState,
            getAgentLocalCliConfig: (agentId: string) => ({
                agentId,
                detectKey: resolvePackageDetectKey(agentId),
                machineLoginKey: agentId,
                supportKind: 'login_terminal',
                loginLaunch: null,
            }),
            getAgentAuthProbeConfig: (agentId: string) => ({
                agentId,
                binaryNames: [resolvePackageDetectKey(agentId)],
                statusCommand: null,
                parser: 'unknown',
                backgroundChecks: agentsPackageState.isAgentAuthProbeSafeForBackgroundChecks(agentId) ? 'safe' : 'manual_only',
            }),
        }));
        const { CAPABILITIES_REQUEST_MACHINE_DETAILS: request } = await import('./requests');

        expect(request.overrides?.['cli.codex']).toMatchObject({
            params: {
                includeLoginStatus: true,
            },
        });
        expect(request.overrides?.['cli.codex-alt']).toBeUndefined();
    });
});
