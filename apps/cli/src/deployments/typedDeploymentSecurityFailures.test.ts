import { expect, it } from 'vitest';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { deploymentArtifactReadFailureV1 } from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';
import { resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { MachineNativeEffectAdmissionError } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { refuseDeploymentArtifactRead } from './deploymentFailure';
import { createDeploymentArtifactHeaderReader } from './readArtifactHeadersForHost';
import { resolveEnvironmentDeploymentFactForHost } from './secrets/deploymentFacts';
import { admitDeploymentTargetCredentialPrincipalForHost } from './targets/admitDeploymentTargetCredentialPrincipalForHost';
import { resolveOwnServerDataServiceDeclarationForHost } from './targets/ownServer/dataQueryScope';

it('security: retains requester artifact authority refusal in the Action result', async () => {
    const read = createDeploymentArtifactHeaderReader({ serverHttpBaseUrl: 'https://home.invalid', assertCurrent: async () => {} });
    let caught: unknown;
    try { await read(['artifact'], {}); } catch (error) { caught = error; }
    expect(normalizeActionExecutorThrownError(caught)).toMatchObject({ errorCode: 'project_requester_authority_unavailable' });
});

const projected = (refusal: () => unknown) => {
    try { refusal(); } catch (error) { return normalizeActionExecutorThrownError(error); }
    throw new Error('Expected a refusal');
};

it.each<[string, () => unknown, Readonly<Record<string, unknown>>]>([
    ['secret binding fact', () => resolveEnvironmentDeploymentFactForHost('commitSha' as never, {} as never),
        { errorCode: 'reference_unavailable' }],
    ['target credential principal', () => admitDeploymentTargetCredentialPrincipalForHost({
        credentialPrincipal: { kind: 'team', selection: { deliveryMode: 'relay' } } } as never, 'owner'),
        { errorCode: 'deployment_target_role_unavailable' }],
    ['own-server data scope', () => resolveOwnServerDataServiceDeclarationForHost({} as never, 'database'), { errorCode: 'target_mismatch' }],
    ['native effect admission', () => { throw new MachineNativeEffectAdmissionError('plan_changed', 'operation'); },
        { errorCode: 'plan_changed', details: { actionOperationId: 'operation' } }],
    ['requester Saved Secret custody', () => resolveRequesterSavedSecretActionCustody({
        authorization: {} as never, credentials: {} as never }), { errorCode: 'client_required' }],
    ['artifact read refusal', () => refuseDeploymentArtifactRead(deploymentArtifactReadFailureV1('header')),
        { errorCode: 'deployment_content_unavailable', failureCause: { phase: 'deployment.artifact.header' } }],
])('security: retains the %s refusal in the Action result', (_family, refusal, expected) => {
    expect(projected(refusal)).toMatchObject(expected);
});
