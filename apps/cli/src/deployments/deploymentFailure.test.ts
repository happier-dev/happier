import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecuteFailureSchema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createMachineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { logger } from '@/ui/logger';
import { projectDeploymentException, projectDeploymentFailure, projectDeploymentReceiptFailure, privateServiceForwardAcquisitionError } from './deploymentFailure';
import { inspectNativeComposeStorage } from '@/daemon/local/services/launch/nativeComposeStorage';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { MachineCarrierError } from '@/daemon/peer/iroh/machineCarrier';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployment-protocol';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';

describe('deployment failure diagnostics', () => {
    it('surfaces value-free schema issue paths when preparation rejects receipt content', () => {
        const parsed = DeploymentOwnServerContentV1Schema.safeParse({ machines: [],
            platform: { providerDeploymentId: 'private-provider-deployment' } });
        if (parsed.success) throw new Error('Expected the native receipt schema to reject platform content');
        const failure = ActionExecuteFailureSchema.parse(projectDeploymentFailure('deployment_content_unavailable', parsed.error,
            'deployment.prepare.receipt'));
        expect(failure).toMatchObject({ errorCode: 'invalid_action_output',
            details: { issues: expect.arrayContaining([expect.objectContaining({ path: ['buildMachineId'], code: 'invalid_type' })]) },
            failureCause: { phase: 'deployment.prepare.receipt', errorClass: expect.stringMatching(/ZodError/) } });
        expect(JSON.stringify(failure)).not.toContain('private-provider-deployment');
    });
    it('retains an authored cause for a generic PluginError without exposing its private details', () => {
        const failureCause = projectActionFailureCauseV1({ code: 'invalid_request' }, 'deployment.build.secret_build_argument');
        const result = projectDeploymentFailure('invalid_request', new PluginError({ code: 'invalid_request',
            details: { token: 'private-native-token' }, failureCause }));
        expect(result.failureCause).toEqual(failureCause);
        expect(JSON.stringify(result)).not.toContain('private-native-token');
    });
    it('retains an authored reference cause through deployment exception projection', () => {
        const failureCause = projectActionFailureCauseV1({ code: 'service_export_unavailable' }, 'deployment.reference.resolve');
        const error = Object.assign(new Error('reference_unavailable'), { code: 'reference_unavailable', failureCause });
        expect(projectDeploymentException(error).failureCause).toEqual(failureCause);
    });

    it.each([
        [new MachineCarrierError('service_export_unavailable', 'private-export'), 'private_service_forward_refused'],
        [Object.assign(new Error('private-destination'), { code: 'ECONNREFUSED' }), 'private_service_destination_unreachable'],
        [new MachineCarrierError('machine_carrier_unavailable', 'private-carrier'), 'machine_carrier_unavailable'],
    ])('publishes the private forward failure without exposing transport error text', (error, code) => {
        const failure = privateServiceForwardAcquisitionError(error);
        const result = projectDeploymentFailure(failure.code, failure);
        expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ ok: false, errorCode: code });
        expect(result.failureCause).toBeDefined();
        expect(JSON.stringify(result)).not.toContain('private-');
    });
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

    it('retains closed native maintenance evidence without forwarding arbitrary PluginError details', () => {
        const nativeFailure = { exitCode: 7, stderr: 'pg_dump: database does not exist', stderrTruncated: false };
        const error = new PluginError({ code: 'restore_failed', details: {
            nativeFailure, kind: 'recoveryRequired', token: 'private-native-token',
        } });
        const projected = ActionExecuteFailureSchema.parse(projectDeploymentFailure(error.code, error));
        expect(projected).toMatchObject({ ok: false, errorCode: 'restore_failed', details: { nativeFailure } });
        expect(JSON.stringify(projected)).not.toContain('private-native-token');
        expect(projected.details).not.toHaveProperty('kind');
        const invalid = projectDeploymentFailure(error.code, new PluginError({ code: error.code,
            details: { nativeFailure: { ...nativeFailure, token: 'private-native-token' } } }));
        expect(invalid.details).not.toHaveProperty('nativeFailure');
        expect(JSON.stringify(invalid)).not.toContain('private-native-token');
    });

    it('publishes the closed native backup network refusal with actionable recovery', () => {
        const code = 'service_admission_unavailable';
        const details = { reason: 'backup_destination_host_network_unavailable' };
        const result = projectDeploymentFailure(code, new PluginError({ code,
            message: 'private-native-endpoint', details }));
        expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ ok: false, errorCode: code,
            error: expect.stringMatching(/container-reachable/), details: { ...details,
                requiredFact: 'nativeLinuxHostNetwork', remedy: expect.stringMatching(/container-reachable/) } });
        expect(JSON.stringify(result)).not.toContain('private-native-endpoint');
        const opaque = projectDeploymentFailure(code, new PluginError({ code,
            details: { ...details, endpoint: 'private-native-endpoint' } }));
        expect(opaque.details).not.toHaveProperty('reason');
        expect(JSON.stringify(opaque)).not.toContain('private-native-endpoint');
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

describe('deployment exception projection', () => {
    afterEach(() => vi.restoreAllMocks());

    it('retains the managed native owner’s closed cause in public output and the receipt', () => {
        const failureCause = projectActionFailureCauseV1({ code: 'native_route_unavailable' }, 'machines.snapshot');
        const nativeCause = { localCause: 'native_route_unavailable' as const };
        const result = projectDeploymentException(new ManagedMachineControllerError('native_failed', undefined,
            { kind: 'managedNative', nativeCause }, failureCause));
        expect(result).toMatchObject({ errorCode: 'native_failed', details: { kind: 'managedNative', nativeCause }, failureCause });
        expect(projectDeploymentReceiptFailure(result, 'restore')).toMatchObject({ code: 'native_failed', failureCause });
    });

    it('settles an uncoded throw as a typed unknown failure with its class, never as missing Source content', () => {
        const warning = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const result = projectDeploymentException(new Error('private-native-message token=private-native-value'),
            { phase: 'deployment.backup.publication' });

        expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ ok: false, errorCode: 'action_failed',
            failureCause: { phase: 'deployment.backup.publication', errorClass: 'Error', errorCode: null } });
        const recovery = readDeploymentFailureRecoveryV1(result.errorCode, result.details);
        expect(recovery.nextAction.destination).not.toBe('source');
        expect(recovery.remedy).not.toMatch(/source/i);
        // Class and redacted message reach only the private diagnostic log.
        expect(warning).toHaveBeenCalledWith('[Deployment] Unavailable', expect.objectContaining({
            phase: 'deployment.backup.publication', exception: expect.objectContaining({ errorClass: 'Error' }) }));
        expect(JSON.stringify(warning.mock.calls)).not.toContain('private-native-value');
        expect(JSON.stringify(result)).not.toContain('private-native');
    });

    it('keeps a typed throw code and a cancellation without the unknown-failure diagnostic', () => {
        const warning = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        expect(projectDeploymentException(Object.assign(new Error('private-native-message'), { code: 'backup_failed' })))
            .toMatchObject({ ok: false, errorCode: 'backup_failed', failureCause: { errorCode: 'backup_failed' } });
        const aborted = new AbortController();
        aborted.abort();
        expect(projectDeploymentException(new Error('private-native-message'), { signal: aborted.signal }))
            .toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(warning).not.toHaveBeenCalled();
    });
});

describe('deployment native typed reason', () => {
    it('carries the native Start First eligibility reason into the public cause, the receipt and its recovery', async () => {
        // The real storage classifier refuses a writable named volume for Start First.
        const error: unknown = await inspectNativeComposeStorage({ runtimeMachineCount: 1, requireStateless: true,
            model: { services: { app: { volumes: [{ type: 'volume', source: 'archive-data', target: '/data' }] } },
                volumes: { 'archive-data': {} } },
            imageConfigs: new Map([['app', { config: {} }]]), isUnchangedManifestSource: async () => false }).then(() => null, (refusal: unknown) => refusal);
        expect(error).toMatchObject({ code: 'native_failed' });
        const result = projectDeploymentFailure('native_failed', error);
        expect(result).toMatchObject({ ok: false, errorCode: 'native_failed',
            failureCause: { errorCode: 'deployment_start_first_unavailable' } });
        const receipt = projectDeploymentReceiptFailure(result, 'activate');
        expect(receipt).toMatchObject({ code: 'native_failed', phase: 'activate',
            failureCause: { errorCode: 'deployment_start_first_unavailable' } });
        const recovery = readDeploymentFailureRecoveryV1(receipt.code, { failure: receipt });
        expect(recovery).toMatchObject({ remedy: receipt.remedy, nextAction: { destination: 'settings' } });
        expect(recovery.remedy).toMatch(/Start First/);
    });
});
