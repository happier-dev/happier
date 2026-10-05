import { describe, expect, it } from 'vitest';
import { isPluginError } from '@happier-dev/plugin-sdk';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { createAgentCliSystemToolService } from './agentCliBinding';

describe('Agent CLI system-tool startup prerequisite', () => {
    it('reports a missing CLI through the public PluginError contract with safe remediation', async () => {
        const home = createTempDirSync('happier-missing-agent-system-tool-');
        const agentId = 'private-agent-identity';
        try {
            const service = createAgentCliSystemToolService({
                agentId,
                runtimeSpec: {
                    id: agentId, title: 'Private Agent', binaryName: 'private-agent',
                    knownUserBinDirSuffixes: [], sourcePreferenceDefault: 'system-first',
                    managedInstall: null, manualInstallKind: 'none', manualInstallRecipes: null,
                    acceptsJavaScriptFileOverride: false,
                },
                binding: { toolId: 'agent-cli' },
                definition: { toolId: 'agent-cli', displayName: 'Agent CLI', lookupNames: ['private-agent'] },
                processEnv: { PATH: '', HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home },
                delegate: { async resolve() { throw new Error('Unrelated tool must not be resolved'); } },
            });
            const failure = await service.resolve({ toolId: 'agent-cli', purpose: 'Open Agent Session' })
                .then(() => undefined, (error: unknown) => error);
            expect(isPluginError(failure)).toBe(true);
            expect(failure).toMatchObject({ code: 'agent_cli_missing', retryable: false });
            if (!isPluginError(failure)) throw new Error('Expected the canonical PluginError contract');
            expect(failure.message).toMatch(/install.*CLI|CLI.*install/iu);
            expect(failure.message).not.toContain(agentId);
            expect(failure.message).not.toContain(home);
        } finally {
            removeTempDirSync(home);
        }
    });
});
