import { expect, it } from 'vitest';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { resolveScmHostingRefForHost } from './resolveRefForHost';

it('keeps missing hosting support typed through the deployment failure normalizer', async () => {
    const failure = await resolveScmHostingRefForHost({
        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'owner/repository', visibility: 'private' }, protocol: 'https' },
        ref: 'main', context: {},
    }).catch(error => normalizeActionExecutorThrownError(error));
    expect(failure).toMatchObject({ errorCode: 'scm_ref_resolution_unavailable',
        failureCause: { errorCode: 'scm_ref_resolution_unavailable' } });
});
