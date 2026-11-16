import { expect, it } from 'vitest';
import { normalizeActionExecutorThrownError } from '../actions/executor/resultProjection.js';
import { captureDeploymentBindingSavedSecretRevisionsV1 } from './deploymentBindingPatchV1.js';
import { EnvironmentSecretBindingV1Schema, parseDeploymentComposeSourceV1 } from './storedAppInputV1.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';

it('retains conflicting binding revisions as deployment_invalid through the Action result', () => {
    const binding = (name: string, resourceRevision: number) => EnvironmentSecretBindingV1Schema.parse({
        purpose: 'variable', phase: 'runtime', name, grantRef: '00000000-0000-4000-8000-000000000010', source: { kind: 'secret',
            ref: formatSharedSavedSecretRefV1('resource'), resourceRevision } });
    let caught: unknown;
    try { captureDeploymentBindingSavedSecretRevisionsV1([binding('ONE', 1), binding('TWO', 2)]); }
    catch (error) { caught = error; }
    expect(normalizeActionExecutorThrownError(caught)).toMatchObject({ errorCode: 'deployment_invalid', error: 'deployment_invalid' });
});

it.each(['[broken', 'scalar'])('retains invalid Compose syntax/shape as invalid_request: %s', async document => {
    let caught: unknown;
    try { await parseDeploymentComposeSourceV1(document); } catch (error) { caught = error; }
    expect(normalizeActionExecutorThrownError(caught)).toMatchObject({ errorCode: 'invalid_request', error: 'Invalid Compose source' });
});
