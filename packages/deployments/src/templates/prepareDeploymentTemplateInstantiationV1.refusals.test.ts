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

// Supabase derived generators consume the same admitted signing key, regardless of variable order.
it('orders JWT generation after its signing secret and refuses an ungenerated signing dependency before effects', () => {
    const template = { ...input.template,
        variables: [{ ...input.template.variables[0]!, key: 'TOKEN' }, input.template.variables[0]!],
        generatedSecrets: [{ key: 'TOKEN', purpose: 'token', label: 'Token', profile: { kind: 'jwt-hs256' as const,
            secretKey: 'APP_PASSWORD', payload: { role: 'anon' as const, iss: 'supabase' as const, exp: 1893456000 } } }, ...input.template.generatedSecrets] };
    const bindings = ['TOKEN', 'APP_PASSWORD'].map(name => ({ purpose: 'variable' as const, name, phase: 'runtime' as const,
        source: { kind: 'generated' as const, key: name } }));
    expect(prepareDeploymentTemplateInstantiationV1({ ...input, template, bindings }).generatedSecrets.map(secret => secret.key))
        .toEqual(['APP_PASSWORD', 'TOKEN']);
    const renamed = prepareDeploymentTemplateInstantiationV1({ ...input, template, bindings, reservedVariableNames: ['APP_PASSWORD'] });
    expect(renamed.generatedSecrets).toMatchObject([
        { key: 'APP_PASSWORD_2' }, { key: 'TOKEN_2', profile: { kind: 'jwt-hs256', secretKey: 'APP_PASSWORD_2' } },
    ]);
    expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, template, bindings: [bindings[0]!, {
        purpose: 'variable', name: 'APP_PASSWORD', phase: 'runtime', source: { kind: 'secret', ref: 'happier:shared-secret:v1:existing' },
    }] })).toThrowError(expect.objectContaining({ code: 'template_needs_review', details: { key: 'TOKEN', dependency: 'APP_PASSWORD' } }));
});
