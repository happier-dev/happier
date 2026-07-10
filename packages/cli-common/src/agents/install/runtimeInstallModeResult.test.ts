import { describe, expect, it } from 'vitest';

import type { AgentCliInstallPlan } from '../install.js';
import type { RuntimeInstallLifecycleContext } from './runtimeInstallLifecycleContext.js';
import {
    buildRuntimeInstallModeErrorResult,
    buildRuntimeInstallModeOkResult,
} from './runtimeInstallModeResult.js';

const plan: AgentCliInstallPlan = {
    agentId: 'test-agent',
    title: 'Test Agent',
    binaries: ['test-agent'],
    platform: 'linux',
    docsUrl: null,
    commands: [],
    requiresAdmin: false,
    installMode: 'vendor_recipe',
    managedInstall: null,
};

const lifecycleContext: RuntimeInstallLifecycleContext = {
    logPath: '/tmp/test-agent-install.log',
    vendorScratchDir: null,
    appendCommandLog: () => {},
    appendLogLine: () => {},
};

describe('buildRuntimeInstallModeOkResult', () => {
    it('returns the expected success shape', () => {
        expect(buildRuntimeInstallModeOkResult({ plan, lifecycleContext })).toEqual({
            ok: true,
            plan,
            logPath: lifecycleContext.logPath,
            alreadyInstalled: false,
        });
    });
});

describe('buildRuntimeInstallModeErrorResult', () => {
    it('returns the expected error shape', () => {
        expect(
            buildRuntimeInstallModeErrorResult({
                plan,
                lifecycleContext,
                errorCode: 'command-failed',
                errorMessage: 'failed',
            }),
        ).toEqual({
            ok: false,
            plan,
            logPath: lifecycleContext.logPath,
            errorCode: 'command-failed',
            errorMessage: 'failed',
        });
    });
});
