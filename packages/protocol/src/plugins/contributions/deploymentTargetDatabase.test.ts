import { expect, it } from 'vitest';
import { DeploymentTargetContributionV1Schema, readDeploymentTargetReferenceRolesV1 } from './deploymentTargets.js';

it('keeps a managed database engine association separate from executable target roles', () => {
    const closed = { type: 'object', properties: {}, additionalProperties: false };
    const target = DeploymentTargetContributionV1Schema.parse({
        id: 'database', role: 'data', title: 'Selected database', icon: 'server-outline', targetKind: 'example',
        targetSchema: closed, linkSchema: closed,
        dataV1: { database: { engineId: 'postgresql' }, projects: { list: 'projects' } },
    });
    expect(target).toMatchObject({ dataV1: { database: { engineId: 'postgresql' } } });
    expect(readDeploymentTargetReferenceRolesV1(target)).toEqual([{
        role: 'projects.list', reference: 'projects', targetFamily: 'resources',
        path: ['dataV1', 'projects', 'list'], readOnly: true,
    }]);
});
