import { expect, it } from 'vitest';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { assertReviewedDeploymentSource } from './reviewedSource';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './targets/ownServer/paths';
import { privateServiceForwardAcquisitionError, projectDeploymentException, projectDeploymentFailure, projectDeploymentReceiptFailure, rethrowDeploymentSourceAcquisitionFailure } from './deploymentFailure';
import { projectDeploymentReceiptInvestigationV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { CaddyDomainMaterializationError } from './targets/ownServer/caddyRouteMaterialization';
import { observeOwnServerTeardownVolumes } from './targets/ownServer/teardownVolumes';
import { createHappierJsonExecutorFromTextRunner } from '@happier-dev/cli-common/systemTasks';

it('exposes the deepest typed native cause through exact receipt investigation', () => {
    const failureCause = { phase: 'filesystem.listener', errorClass: 'TypeError', errorCode: 'EADDRNOTAVAIL', httpStatus: null };
    const failed = projectDeploymentFailure('filesystem_transfer_failed', {
        ok: false, errorCode: 'filesystem_transfer_failed', error: 'private native message', failureCause,
    });
    const investigation = projectDeploymentReceiptInvestigationV1({
        failure: projectDeploymentReceiptFailure(failed, 'activate'),
    });
    expect(investigation.failure).toMatchObject({ code: 'filesystem_transfer_failed', phase: 'activate', failureCause });
    expect(JSON.stringify(investigation)).not.toContain('private native message');
});

it('names the failed guest CLI step and its output in the deploy cause, without its secrets', async () => {
    // F14 E2EE: App enrollment's guest `happier … --json` exited non-zero and the deploy said only cli_command_failed.
    const executor = createHappierJsonExecutorFromTextRunner(async () => ({ status: 3, stdout: '',
        stderr: 'x Daemon exited: Authorization: Bearer secret-guest-token' }));
    const failure = await executor.runHappierJson(['--server', 'home', 'daemon', 'status', '--json']).then(() => null, error => error);
    const projected = projectDeploymentException(failure, { phase: 'deployment.failure' });
    expect(projected).toMatchObject({ errorCode: 'cli_command_failed', details: { kind: 'managedNative', nativeCause: {
        localCause: 'native_command_failed', command: 'run', exitCode: 3,
        failureCause: { phase: 'guest_cli.daemon.status', errorCode: 'cli_command_failed' },
        stderr: expect.stringContaining('Daemon exited') } } });
    expect(JSON.stringify(projected)).not.toContain('secret-guest-token');
});

it('retains source review refusals in the Action result', () => {
    const content = createDeploymentReceiptDetailV1().content;
    let caught: unknown;
    try { assertReviewedDeploymentSource({ intent: { serverId: 'home', environmentId: 'env', targetLinkId: 'link', services: ['db'] }, content }); }
    catch (error) { caught = error; }
    expect(normalizeActionExecutorThrownError(caught)).toMatchObject({ errorCode: 'target_mismatch', error: 'target_mismatch' });
});

it('retains native deployment identity validation in the Action result', () => {
    let caught: unknown;
    try { resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', '../other'); }
    catch (error) { caught = error; }
    expect(normalizeActionExecutorThrownError(caught)).toMatchObject({ errorCode: 'invalid_request', error: 'Invalid deployment identity' });
});

it('retains service forward acquisition failures and their cause', () => {
    const native = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const error = privateServiceForwardAcquisitionError(native);
    expect(error.cause).toBeDefined();
    expect(normalizeActionExecutorThrownError(error)).toMatchObject({ errorCode: 'private_service_destination_unreachable' });
});

it.each(['git_selection_unavailable', 'not_found'])('retains source acquisition translation and its cause for %s', code => {
    let caught: unknown;
    try { rethrowDeploymentSourceAcquisitionFailure(Object.assign(new Error('selection unavailable'), { code })); }
    catch (error) { caught = error; }
    expect(caught).toHaveProperty('cause');
    expect(normalizeActionExecutorThrownError(caught)).toMatchObject({ errorCode: 'deployment_source_unavailable',
        failureCause: { phase: 'deployment.source.acquire', errorCode: code } });
});

it('retains Domain materialization validation in the Action result', () => {
    expect(normalizeActionExecutorThrownError(new CaddyDomainMaterializationError())).toMatchObject({
        errorCode: 'invalid_parameters', error: 'Unsupported canonical redirect destination' });
});

it('retains teardown inventory refusal in the Action result', async () => {
    // Native Docker execution is the process boundary.
    let caught: unknown;
    try { await observeOwnServerTeardownVolumes({ resources: [{ id: 'volume', kind: 'data', ownership: 'owned', disposition: 'remove' }],
        run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) }); } catch (error) { caught = error; }
    expect(normalizeActionExecutorThrownError(caught)).toMatchObject({ errorCode: 'volume_observation_unavailable' });
});
