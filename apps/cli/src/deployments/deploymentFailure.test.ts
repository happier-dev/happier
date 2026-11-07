import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecuteFailureSchema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createMachineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { logger } from '@/ui/logger';
import { projectDeploymentFailure } from './deploymentFailure';

describe('deployment failure diagnostics', () => {
    it.each(['deployment_content_unavailable', 'deployment_unavailable', 'unsupported', 'unclassified_provider_refusal'])(
        'supplies recovery for %s without a refusal-code classification', errorCode => {
            const result = projectDeploymentFailure(errorCode);
            expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ ok: false, errorCode,
                details: { requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
        });

    it('retains closed source admission facts from the SDK PluginError author payload', () => {
        const code = 'agent_isolation_unavailable';
        const details = { phase: 'deployment_source_admission', reason: 'requester_authority_unavailable',
            requiredFact: 'verified_root_requester', remedy: 'retry_original_request' };
        const failureCause = projectActionFailureCauseV1(new Error(code), 'deployment.source.admission.requester_authority_unavailable');
        const result = projectDeploymentFailure(code, new PluginError({ code, retryable: false, details, failureCause }));

        expect(result).toEqual({ ok: false, errorCode: code, error: code, details, failureCause });
        const opaque = projectDeploymentFailure(code, new PluginError({ code,
            details: { ...details, token: 'private-source-token' } }));
        expect(opaque.details).toEqual({ requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) });
        expect(JSON.stringify(opaque)).not.toContain('private-source-token');
    });

    it('retains only the secret owner’s value-free missing-name refusal', () => {
        const details = { deployable: false, missingRequiredSecretNames: ['STRIPE_SECRET_KEY'] };
        expect(projectDeploymentFailure('secret_missing', new PluginError({ code: 'secret_missing', details })))
            .toMatchObject({ ok: false, errorCode: 'secret_missing', details });
        const opaque = projectDeploymentFailure('secret_missing', new PluginError({ code: 'secret_missing',
            details: { ...details, value: 'private-secret-value' } }));
        expect(opaque.details).not.toHaveProperty('missingRequiredSecretNames');
        expect(JSON.stringify(opaque)).not.toContain('private-secret-value');
    });

    it('retains the incumbent native operation through the published failure envelope', async () => {
        const admission = createMachineNativeEffectAdmission();
        const keys = [{ kind: 'dockerEngine' as const, dockerEndpoint: 'engine' }];
        await admission.run({ operation: { operationId: 'incumbent-remove', kind: 'machine_setup' }, keys }, async () => {
            let failure: unknown;
            try {
                await admission.run({ operation: { operationId: 'next-build', kind: 'deployment_build' }, keys }, async () => {
                    throw new Error('Conflicting build must not run');
                });
            } catch (error) { failure = projectDeploymentFailure('effect_in_progress', error); }
            expect(ActionExecuteFailureSchema.parse(JSON.parse(JSON.stringify(failure)))).toMatchObject({
                ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'incumbent-remove' },
            });
        });
    });
});

describe('deployment filesystem failure diagnostics', () => {
    afterEach(() => vi.restoreAllMocks());

    it('retains native syscall and path only in the private file log', async () => {
        // The real filesystem supplies errno metadata; only the private log sink is replaced.
        const directory = await mkdtemp(join(tmpdir(), 'happier-deployment-failure-'));
        const path = join(directory, 'missing-context');
        const warning = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        try {
            const error: unknown = await readFile(path).catch((failure: unknown) => failure);
            const result = projectDeploymentFailure('ENOENT', error);

            expect(warning).toHaveBeenCalledWith('[Deployment] Filesystem operation failed', {
                errorClass: 'Error', code: 'ENOENT', syscall: 'open', path,
            });
            expect(result).toMatchObject({ ok: false, errorCode: 'ENOENT', error: 'ENOENT',
                failureCause: { errorCode: 'ENOENT' } });
            expect(JSON.stringify(result)).not.toContain(path);
            expect(JSON.stringify(result)).not.toContain('syscall');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('keeps ordinary error text and arbitrary properties out of the diagnostic', () => {
        const warning = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const result = projectDeploymentFailure('deployment_failed', Object.assign(new Error('private-native-message'), {
            environment: { PRIVATE_TOKEN: 'private-native-value' },
        }));

        expect(warning).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, errorCode: 'deployment_failed', error: 'deployment_failed' });
        expect(JSON.stringify(result)).not.toContain('private-native');
    });
});
