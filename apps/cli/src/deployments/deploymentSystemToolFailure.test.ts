import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { readDeploymentChildResult } from './deploymentChild';
import { readDeploymentSystemToolFailure } from './deploymentSystemToolFailure';

describe('deployment missing-system-tool diagnostic', () => {
    it('retains the closed Docker remedy through child JSON and a controller refusal, omitting private details', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-missing-deploy-tool-'));
        try {
            const resolver = createPluginExecSystemToolResolver({
                definitions: [{ toolId: 'docker', displayName: 'Docker', lookupNames: ['docker'] }],
                baseEnv: { PATH: root }, registerGrant() { throw new Error('Unexpected tool grant'); },
            });
            const missing = await resolver.resolve({ toolId: 'docker', purpose: 'deployment-native-compose' })
                .catch((error: unknown) => error);
            const failure = readDeploymentSystemToolFailure('plugin_exec_system_tool_unavailable', missing);
            expect(failure).toMatchObject({ ok: false, details: { toolId: 'docker' } });
            if (!failure) throw new Error('Missing system tool diagnostic');
            const details = failure.details;
            if (!details || typeof details !== 'object' || Array.isArray(details)) throw new Error('Missing typed tool details');
            const wire: unknown = JSON.parse(JSON.stringify({ ...failure, error: 'private-stderr-sentinel',
                details: { ...details, nativePath: root, secret: 'private-secret-sentinel' } }));
            const child = readDeploymentChildResult(wire);
            const result = readDeploymentSystemToolFailure(failure.errorCode, new Error(failure.errorCode, { cause: child }));
            expect(ActionExecuteFailureSchema.parse(result)).toEqual(failure);
            expect(JSON.stringify(result)).not.toContain(root);
            expect(JSON.stringify(result)).not.toContain('private-');
            expect(readDeploymentSystemToolFailure('cancelled', missing)).toBeNull();
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('does not expose arbitrary tool identities or incomplete diagnostics', () => {
        for (const details of [undefined, { kind: 'systemToolUnavailable', toolId: '/private/tool',
            remedy: 'install_on_machine_and_add_to_daemon_path' }, { kind: 'systemToolUnavailable', toolId: 'docker' }]) {
            expect(readDeploymentSystemToolFailure('plugin_exec_system_tool_unavailable', {
                ok: false, errorCode: 'plugin_exec_system_tool_unavailable', error: 'private error', details,
            })).toBeNull();
        }
    });
});
