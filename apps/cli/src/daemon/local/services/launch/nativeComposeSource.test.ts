import { expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withNativeComposeBuildFixture } from './nativeComposeBuild.testkit';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { readDeploymentChildResult } from '@/deployments/deploymentChild';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

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
        expect(readDeploymentChildResult(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
        expect(readDeploymentFailureRecoveryV1(failure.errorCode, failure).nextAction.destination).toBe('source');
        expect(requests.some(request => request.args.includes('bake') || request.args.includes('up'))).toBe(false);
    });
});
