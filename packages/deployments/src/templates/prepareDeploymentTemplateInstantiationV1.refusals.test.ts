import { expect, it } from 'vitest';
import { prepareDeploymentTemplateInstantiationV1, type DeploymentTemplateInstantiationPreparationInputV1 } from './prepareDeploymentTemplateInstantiationV1.js';

// The planner consumes admitted descriptors; no registry or protocol runtime is needed here.
const input = {
    template: { schemaVersion: 1, title: 'App', compose: { document: '', profiles: [], services: ['web'] },
        variables: [{ key: 'APP_PASSWORD', label: 'Password', required: true, secret: true, valueKind: 'string',
            sites: [{ service: 'web', path: ['environment', 'PASSWORD'] }] }],
        generatedSecrets: [{ key: 'APP_PASSWORD', purpose: 'password', label: 'Password', profile: { kind: 'hex-32-bytes' } }],
        domains: [], volumes: [] },
    templateRef: { sourceId: 'apps', itemId: 'app', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
    source: { services: { web: { image: 'app:1', environment: { PASSWORD: '${APP_PASSWORD}' } } } },
    bindings: [],
} satisfies DeploymentTemplateInstantiationPreparationInputV1;

it('identifies an undeclared generator selection without blaming catalog readiness', () => {
    expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, bindings: [{ purpose: 'variable', name: 'APP_PASSWORD',
        phase: 'runtime', source: { kind: 'generated', key: 'requested-password' } }] }))
        .toThrowError(expect.objectContaining({ code: 'template_generator_undeclared',
            message: expect.stringContaining('requested-password'), details: { key: 'requested-password' } }));
});

it('keeps the declared generator profile available without generating secret bytes', () => {
    const prepared = prepareDeploymentTemplateInstantiationV1({ ...input, bindings: [{ purpose: 'variable', name: 'APP_PASSWORD',
        phase: 'runtime', source: { kind: 'generated', key: 'APP_PASSWORD' } }] });
    expect(prepared.generatedSecrets).toEqual([{ name: 'APP_PASSWORD', phase: 'runtime', key: 'APP_PASSWORD',
        profile: { kind: 'hex-32-bytes' } }]);
    expect(prepared.bindings).toEqual([]);
});
