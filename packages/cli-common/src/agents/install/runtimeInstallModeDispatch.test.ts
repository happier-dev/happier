import { describe, expect, it } from 'vitest';

import { getAgentCliRuntimeSpec } from '@happier-dev/agents';

import { runRuntimeInstallModeDispatch } from './runtimeInstallModeDispatch.js';
import type { AgentCliInstallPlan } from '../install.js';
import type { RuntimeInstallLifecycleContext } from './runtimeInstallLifecycleContext.js';

const runtimeSpec = getAgentCliRuntimeSpec('codex');

const plan: AgentCliInstallPlan = {
    agentId: runtimeSpec.id,
    title: runtimeSpec.title,
    binaries: [runtimeSpec.binaryName],
    platform: 'linux',
    docsUrl: runtimeSpec.docsUrl ?? null,
    commands: [
        {
            cmd: 'definitely-not-a-command-for-cli-common-tests',
            args: [],
            requiresAdmin: false,
            note: null,
        },
    ],
    requiresAdmin: false,
    installMode: 'vendor_recipe',
    managedInstall: null,
};

const lifecycleContext: RuntimeInstallLifecycleContext = {
    logPath: '/tmp/runtime-install-dispatch.log',
    vendorScratchDir: null,
    appendCommandLog: () => {},
    appendLogLine: () => {},
};

describe('runRuntimeInstallModeDispatch', () => {
    it('returns the vendor recipe failure result for a missing command', async () => {
        await expect(
            runRuntimeInstallModeDispatch({
                runtimeSpec,
                plan,
                env: { PATH: '' },
                lifecycleContext,
                deps: {},
            }),
        ).resolves.toEqual({
            ok: false,
            plan,
            logPath: lifecycleContext.logPath,
            errorCode: 'command-not-found',
            errorMessage: 'Command not found: definitely-not-a-command-for-cli-common-tests',
        });
    });
});
