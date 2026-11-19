import { expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withNativeComposeBuildFixture } from './nativeComposeBuild.testkit';
import { projectDeploymentException, projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { readDeploymentChildResult } from '@/deployments/deploymentChild';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { projectExternalActionExecutionResultV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { normalizeActionExecuteResult, projectCliActionFailure } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { formatHappierMcpToolFailure } from '@/mcp/server/registerHappierMcpBuiltInTools';

it('names the missing selected Compose file through native preparation and child transport with Source recovery', async () => {
    await withNativeComposeBuildFixture(async ({ project, source, requests }) => {
        // The immutable source and filesystem reader are real; only Docker is a process boundary fixture.
        await rm(join(source.rootPath, 'compose.yaml'));
        const error: unknown = await project.prepareImages({ planOnly: true }).catch((failure: unknown) => failure);
        expect(error).toMatchObject({ code: 'deployment_source_unavailable' });
        const failure = projectDeploymentFailure('deployment_source_unavailable', error);
        expect(failure).toMatchObject({ errorCode: 'deployment_source_unavailable',
            details: { kind: 'deploymentSourceFileUnavailable', path: 'compose.yaml', reason: 'absent' },
            failureCause: { phase: 'deployment.source.compose_file.absent' } });
        expect(failure.error).toContain('compose.yaml');
        // The cause states the fact; its one remedy is the typed recovery (DEPLOY-ACCEPT-143 C1), never a second,
        // different instruction to edit a Compose path the person may not need to change.
        expect(failure.error).not.toContain('Environment Settings');
        expect(readDeploymentChildResult(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
        expect(readDeploymentFailureRecoveryV1(failure.errorCode, failure).nextAction.destination).toBe('source');
        expect(requests.some(request => request.args.includes('bake') || request.args.includes('up'))).toBe(false);
    });
});

it.each([
    ['manifest unknown', 'deployment_image_not_found', 'could not find'],
    ['registry.example.test/web:mutable: not found', 'deployment_image_not_found', 'could not find'],
    ['unauthorized: authentication required', 'deployment_image_pull_denied', 'denied access'],
    ['connection timed out', 'native_compose_command_failed', 'could not resolve'],
] as const)('preserves a review image lookup failure (%s) for CLI and agent Actions', async (stderr, reason, explanation) => {
    await withNativeComposeBuildFixture(async ({ project, requests }) => {
        const error: unknown = await project.prepareImages({ planOnly: true }).catch((failure: unknown) => failure);
        const failure = projectDeploymentException(error);
        const details = { kind: 'deploymentImageResolutionFailure', service: 'web',
            reference: 'registry.example.test/web:mutable', reason };
        expect(requests.some(request => request.args.slice(0, 3).join(' ') === 'buildx imagetools inspect'
            && request.args.at(-1) === details.reference)).toBe(true);
        expect(failure).toMatchObject({ errorCode: 'native_failed', details, failureCause: { errorCode: reason } });
        expect(failure.error).toContain(details.reference);
        expect(failure.error).toContain(explanation);
        const wireFailure: unknown = JSON.parse(JSON.stringify(failure));
        expect(readDeploymentChildResult(wireFailure)).toEqual(wireFailure);
        const external = projectExternalActionExecutionResultV1(failure);
        expect(external).toEqual(wireFailure);
        if (!external) throw new Error('Expected a transportable Action failure');
        const cli = normalizeActionExecuteResult(external);
        expect(cli).toMatchObject({
            ok: false, errorCode: failure.errorCode, errorMessage: failure.error, details, failureCause: failure.failureCause,
        });
        if (!cli.ok) expect(projectCliActionFailure(cli)).toMatchObject({
            code: failure.errorCode, message: failure.error, details, failureCause: failure.failureCause,
        });
        const tool = formatHappierMcpToolFailure(failure);
        expect(tool.isError).toBe(true);
        expect(JSON.parse(tool.content[0]?.type === 'text' ? tool.content[0].text : 'null')).toMatchObject({
            errorCode: failure.errorCode, error: failure.error, details, failureCause: failure.failureCause,
        });
        expect(JSON.stringify(failure)).not.toContain('PRIVATE_REGISTRY_OUTPUT');
        expect(requests.some(request => request.args.includes('up') || request.args.includes('pull'))).toBe(false);
    }, { prebuiltIndex: true, preapprovalIndex: true, failureOutput: { command: 'imagetools', stderr: `ERROR: ${stderr}\nPRIVATE_REGISTRY_OUTPUT` } });
});

it('keeps an interpolated secret out of the review image failure', async () => {
    await withNativeComposeBuildFixture(async ({ project, requests }) => {
        const error: unknown = await project.prepareImages({ planOnly: true }).catch((failure: unknown) => failure);
        const failure = projectDeploymentException(error);
        expect(requests.some(request => request.args.slice(0, 3).join(' ') === 'buildx imagetools inspect')).toBe(true);
        expect(failure.details).toEqual({ kind: 'deploymentImageResolutionFailure', service: 'web',
            reason: 'deployment_image_not_found' });
        expect(failure.error).toContain('web');
        expect(JSON.stringify(failure)).not.toContain('buildkit-only-fixture-secret');
    }, { prebuiltIndex: true, preapprovalIndex: true, prebuiltSecretReference: true,
        failureOutput: { command: 'imagetools', stderr: 'ERROR: manifest unknown' } });
});
