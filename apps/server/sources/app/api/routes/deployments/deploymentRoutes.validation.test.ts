import { expect, it } from 'vitest';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { DeploymentTargetLinksListInputV1Schema } from '@happier-dev/protocol';
import { deploymentLinkValidationFailure } from './deploymentValidation';

it.each(['invalid type', 'unknown field'] as const)('names the inventory refusal without returning private input (%s)', async scenario => {
    const validate = validatorCompiler({ method: 'POST', url: '/v1/deployments/targets/list', httpPart: 'body',
        schema: DeploymentTargetLinksListInputV1Schema });
    const response = await validate({
        serverId: 'home', scope: { kind: 'account', accountId: 'owner' },
        selection: { source: { kind: 'plugin', contribution: {
            pluginId: 'happier.deploy.vercel', localId: 'runtime',
        } }, targetKind: scenario === 'invalid type' ? null : 'vercel' },
        'private-input-must-not-be-echoed': 'private-value-must-not-be-echoed',
    });
    if (!Array.isArray(response.error)) throw new Error('Expected request validation issues');
    const failure = deploymentLinkValidationFailure('target_link.provider_links_read',
        response.error, DeploymentTargetLinksListInputV1Schema.shape);
    expect(failure).toEqual({ ok: false, error: 'deployment_invalid', diagnostic: {
        step: 'target_link.provider_links_read', field: scenario === 'invalid type' ? 'selection' : '$input',
        rule: scenario === 'invalid type' ? 'invalid_type' : 'unrecognized_keys',
    } });
    expect(JSON.stringify(failure)).not.toContain('private-');
});
