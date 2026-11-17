import { expect, expectTypeOf, it } from 'vitest';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { assertDefinePluginCatalogFamilyPolicyClosure, DEFINE_PLUGIN_FAMILY_POLICY_V2 } from './definePlugin.js';
import { definePlugin } from './index.js';
import { parsePluginManifest } from './manifest.js';
import * as publicAuthoring from './index.public.js';
import { DeploymentTargetRoleInputProtocolSchemasV1,
    DeploymentTargetRoleResultV1ProtocolSchema, DeploymentTargetPreparationBaseV1ProtocolSchema,
    hasDeploymentTargetPreparationCoordinatesV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { HEALTH_CHECK_KINDS_V1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { createPluginTestkit } from './testing/host.js';

it('publishes the canonical finite health kinds without a second schema owner', () => {
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
    const definition = { role: 'data', title: 'External database', targetKind: 'external', icon: 'server-outline',
        targetSchema: closed, linkSchema: closed, dataV1: { database: { engineId: 'postgresql' } } } as const satisfies publicAuthoring.DeploymentTargetAuthorDefinitionV1;
    const plugin = definePlugin({
        id: 'com.example.data-target', version: '1.0.0', displayName: 'External database',
        deploymentTargets: { database: definition },
    });
    const parsed = parsePluginManifest(plugin.manifest);
    expect(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes.deploymentTargets).toEqual([{ id: 'database', ...definition }]);
});

it('keeps managed database callbacks private and binds them to the declared target activation', async () => {
    const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
    const runtime = {
        async listTargets() { throw new Error('Discovery is demand-owned'); },
        async open() { throw new Error('Connection acquisition is host-owned'); },
    };
    const plugin = definePlugin({
        id: 'com.example.database-transport', version: '1.0.0',
        deploymentTargets: { database: {
            role: 'data', title: 'Database', targetKind: 'external', icon: 'server-outline',
            targetSchema: closed, linkSchema: closed,
            dataV1: { database: { engineId: 'postgresql', runtime } },
        } },
    });
    expect(plugin.manifest.contributes.deploymentTargets?.[0]).toMatchObject({
        id: 'database', dataV1: { database: { engineId: 'postgresql' } },
    });
    const descriptor = plugin.manifest.contributes.deploymentTargets?.[0];
    expect(descriptor && 'dataV1' in descriptor && descriptor.dataV1?.database).not.toHaveProperty('runtime');
    const testkit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    expect(testkit.registration('deploymentTargets', 'database')).toBe(runtime);
    await testkit.dispose();
    await expect(createPluginTestkit({ manifest: plugin.manifest, module: { activate() {} } }))
        .rejects.toThrow(/missing registration/);
});

it('preserves an external author runtime target through SDK projection and canonical admission', () => {
    const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
    const read = { title: 'Inspect', scopes: ['global'], surfaces: ['plugin'],
        resultSchema: publicAuthoring.DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema, dangerLevel: 'safe', readOnly: true,
        run: async () => ({ v: 1, state: 'succeeded', observedAtMs: 1 }) } as const;
    const write = { ...read, title: 'Deploy', dangerLevel: 'writesLocal', readOnly: false } as const;
    const plans = [{ id: 'free', title: 'Free', facts: [{ label: 'Price', value: '$0' }], included: ['Custom domains'],
        source: { url: 'https://example.com/pricing', checkedAt: '2026-11-16' } }];
    const definition = { role: 'runtime', title: 'External runtime', targetKind: 'external', icon: 'server-outline', plans,
        targetSchema: closed, linkSchema: closed,
        actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe', create: 'create' } } as const satisfies publicAuthoring.DeploymentTargetAuthorDefinitionV1;
    const plugin = definePlugin({
        id: 'com.example.runtime-target', version: '1.0.0', displayName: 'External runtime',
        actions: {
            create: { ...write, inputSchema: Reflect.get(publicAuthoring.DeploymentTargetRoleInputProtocolSchemasV1, 'create').jsonSchema,
                resultSchema: Reflect.get(publicAuthoring, 'DeploymentTargetLinkProviderContentV1ProtocolSchema').jsonSchema },
            inspect: { ...read, inputSchema: publicAuthoring.DeploymentTargetRoleInputProtocolSchemasV1.inspect.jsonSchema },
            link: { ...write, inputSchema: publicAuthoring.DeploymentTargetRoleInputProtocolSchemasV1.link.jsonSchema },
            deploy: { ...write, inputSchema: publicAuthoring.DeploymentTargetRoleInputProtocolSchemasV1.deploy.jsonSchema },
            observe: { ...read, inputSchema: publicAuthoring.DeploymentTargetRoleInputProtocolSchemasV1.observe.jsonSchema },
        },
        deploymentTargets: { runtime: definition },
    });
    const parsed = parsePluginManifest(plugin.manifest);
    expect(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes.deploymentTargets).toEqual([{ id: 'runtime', ...definition }]);
    expect(parsed.manifest.contributes.actions.map(action => action.id).sort()).toEqual(['create', 'deploy', 'inspect', 'link', 'observe']);
    expect(() => assertDefinePluginCatalogFamilyPolicyClosure(PLUGIN_CONTRIBUTION_CATALOG_V2, DEFINE_PLUGIN_FAMILY_POLICY_V2)).not.toThrow();
});
