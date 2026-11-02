import { expect, expectTypeOf, it } from 'vitest';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { assertDefinePluginCatalogFamilyPolicyClosure, DEFINE_PLUGIN_FAMILY_POLICY_V2 } from './definePlugin.js';
import { definePlugin } from './index.js';
import { parsePluginManifest } from './manifest.js';
import * as publicAuthoring from './index.public.js';
import { DeploymentTargetFailureTransitionV1ProtocolSchema, DeploymentTargetRoleInputProtocolSchemasV1,
    DeploymentTargetRoleResultV1ProtocolSchema, DeploymentTargetPreparationBaseV1ProtocolSchema,
    hasDeploymentTargetPreparationCoordinatesV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { HEALTH_CHECK_KINDS_V1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

it('publishes the canonical deployment transition and finite health kinds without a second schema owner', () => {
    expect(Reflect.get(publicAuthoring, 'DeploymentTargetFailureTransitionV1ProtocolSchema'))
        .toBe(DeploymentTargetFailureTransitionV1ProtocolSchema);
    expect(Reflect.get(publicAuthoring, 'HEALTH_CHECK_KINDS_V1')).toBe(HEALTH_CHECK_KINDS_V1);
});

it('publishes the canonical role and preparation contracts through public SDK authoring', () => {
    expectTypeOf<keyof typeof publicAuthoring.DeploymentTargetRoleInputProtocolSchemasV1>()
        .toEqualTypeOf<keyof typeof DeploymentTargetRoleInputProtocolSchemasV1>();
    expect(Reflect.get(publicAuthoring, 'DeploymentTargetRoleInputProtocolSchemasV1')).toBe(DeploymentTargetRoleInputProtocolSchemasV1);
    expect(Reflect.get(publicAuthoring, 'DeploymentTargetRoleResultV1ProtocolSchema')).toBe(DeploymentTargetRoleResultV1ProtocolSchema);
    expect(Reflect.get(publicAuthoring, 'DeploymentTargetPreparationBaseV1ProtocolSchema')).toBe(DeploymentTargetPreparationBaseV1ProtocolSchema);
    expect(Reflect.get(publicAuthoring, 'hasDeploymentTargetPreparationCoordinatesV1')).toBe(hasDeploymentTargetPreparationCoordinatesV1);
});

it('preserves an external data capability without authoring runtime Actions', () => {
    const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
    const read = { title: 'Query', scopes: ['global'], surfaces: ['plugin'],
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['query.readOnly'].jsonSchema,
        resultSchema: closed, dangerLevel: 'safe', readOnly: true, run: async () => ({}) } as const;
    const definition = { role: 'data', title: 'External database', targetKind: 'external', icon: 'server-outline',
        targetSchema: closed, linkSchema: closed, dataV1: { query: { readOnly: 'query' } } } as const satisfies publicAuthoring.DeploymentTargetAuthorDefinitionV1;
    const plugin = definePlugin({
        id: 'com.example.data-target', version: '1.0.0', displayName: 'External database',
        actions: { query: read }, deploymentTargets: { database: definition },
    });
    const parsed = parsePluginManifest(plugin.manifest);
    expect(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes.deploymentTargets).toEqual([{ id: 'database', ...definition }]);
});

it('preserves an external author runtime target through SDK projection and canonical admission', () => {
    const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
    const read = { title: 'Inspect', scopes: ['global'], surfaces: ['plugin'],
        resultSchema: publicAuthoring.DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema, dangerLevel: 'safe', readOnly: true,
        run: async () => ({ v: 1, state: 'succeeded', observedAtMs: 1 }) } as const;
    const write = { ...read, title: 'Deploy', dangerLevel: 'writesLocal', readOnly: false } as const;
    const definition = { role: 'runtime', title: 'External runtime', targetKind: 'external', icon: 'server-outline',
        targetSchema: closed, linkSchema: closed,
        actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe' },
        failureTransitionEvent: 'deployment-transition' } as const satisfies publicAuthoring.DeploymentTargetAuthorDefinitionV1;
    const plugin = definePlugin({
        id: 'com.example.runtime-target', version: '1.0.0', displayName: 'External runtime',
        actions: {
            inspect: { ...read, inputSchema: publicAuthoring.DeploymentTargetRoleInputProtocolSchemasV1.inspect.jsonSchema },
            link: { ...write, inputSchema: publicAuthoring.DeploymentTargetRoleInputProtocolSchemasV1.link.jsonSchema },
            deploy: { ...write, inputSchema: publicAuthoring.DeploymentTargetRoleInputProtocolSchemasV1.deploy.jsonSchema },
            observe: { ...read, inputSchema: publicAuthoring.DeploymentTargetRoleInputProtocolSchemasV1.observe.jsonSchema },
        },
        events: { 'deployment-transition': { declaration: { kind: 'event', title: 'Deployment transition',
            payloadSchema: publicAuthoring.DeploymentTargetFailureTransitionV1ProtocolSchema.jsonSchema } } },
        deploymentTargets: { runtime: definition },
    });
    const parsed = parsePluginManifest(plugin.manifest);
    expect(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes.deploymentTargets).toEqual([{ id: 'runtime', ...definition }]);
    expect(parsed.manifest.contributes.actions.map(action => action.id).sort()).toEqual(['deploy', 'inspect', 'link', 'observe']);
    expect(() => assertDefinePluginCatalogFamilyPolicyClosure(PLUGIN_CONTRIBUTION_CATALOG_V2, DEFINE_PLUGIN_FAMILY_POLICY_V2)).not.toThrow();
});
