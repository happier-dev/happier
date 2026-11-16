import { expect, it } from 'vitest';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { EnvironmentSecretBindingV1Schema } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { prepareEnvironmentSecretBindingsV1 } from './secrets/prepareEnvironmentSecretBindingsV1.js';
import { readResticBackupSummaryV1 } from './backups/manifestV1.js';
import { DeploymentTemplatePreparationErrorV1 } from './templates/prepareDeploymentTemplateInstantiationV1.js';

it('retains binding preparation refusal in the Action result without acquiring material', async () => {
    const binding = (name: string, resourceRevision: number) => EnvironmentSecretBindingV1Schema.parse({
        purpose: 'variable', phase: 'runtime', name, grantRef: '00000000-0000-4000-8000-000000000010', source: { kind: 'secret',
            ref: formatSharedSavedSecretRefV1('resource'), resourceRevision } });
    let caught: unknown;
    try { await prepareEnvironmentSecretBindingsV1({ environmentId: 'env', bindings: [binding('ONE', 1), binding('TWO', 2)],
        previousBindings: [], runtimeInstallations: [], existingGrants: [], async assertCurrent() {},
        sealGrant() { throw new Error('No material should be acquired'); } }); } catch (error) { caught = error; }
    expect(normalizeActionExecutorThrownError(caught)).toMatchObject({ errorCode: 'secret_missing', error: 'secret_missing' });
});

it('retains failed native backup evidence in the Action result', () => {
    let caught: unknown;
    try { readResticBackupSummaryV1('', 1); } catch (error) { caught = error; }
    expect(normalizeActionExecutorThrownError(caught)).toMatchObject({ errorCode: 'backup_failed' });
});

it('retains template preparation code, message and details in the Action result', () => {
    const error = new DeploymentTemplatePreparationErrorV1('template_needs_review', { key: 'service' });
    expect(normalizeActionExecutorThrownError(error)).toMatchObject({ errorCode: 'template_needs_review',
        error: 'template_needs_review: "service"', details: { key: 'service' } });
});
