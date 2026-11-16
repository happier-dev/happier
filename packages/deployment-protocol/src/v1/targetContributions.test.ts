import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import { DeploymentTargetV1Schema } from './target.js';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { DeploymentTargetRoleInputProtocolSchemasV1,
    DeploymentTargetRoleResultV1ProtocolSchema } from './target.js';

const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
const target = {
    id: 'runtime', title: 'Example runtime', icon: 'server-outline', role: 'runtime', targetKind: 'example',
    targetSchema: closed, linkSchema: closed,
    actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe' },
};

function manifest(targets: readonly unknown[] = [target]) {
    return {
        schemaVersion: 2, id: 'example.deploy', version: '0.0.0', displayName: 'Example deployment target',
        entrypoints: { daemon: './daemon.js' }, activation: { events: [] },
        hostAccess: { required: [], optional: [] },
        contributes: {
            deploymentTargets: targets,
            actions: ['inspect', 'link', 'deploy', 'observe', 'upload'].map(id => ({
                id, title: id, scopes: ['global'], surfaces: ['plugin'], execution: { target: 'daemon' },
                inputSchema: DeploymentTargetRoleInputProtocolSchemasV1[id === 'upload' ? 'uploadDeploy' : id as 'inspect' | 'link' | 'deploy' | 'observe'].jsonSchema,
                resultSchema: id === 'deploy' || id === 'observe' || id === 'upload'
                    ? DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema : closed,
                dangerLevel: id === 'inspect' || id === 'observe' ? 'safe' : 'writesLocal',
            })),
        },
    };
}

function admittedTargets(value: unknown) {
    const admitted = ingestPluginManifestV2(value, { mode: 'load' });
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
    return { targets: Reflect.get(admitted.manifest.contributes, 'deploymentTargets'), diagnostics: admitted.diagnostics ?? [] };
}

const dataTarget = {
    id: 'database', title: 'Managed database', icon: 'server-outline', role: 'data', targetKind: 'database',
    targetSchema: closed, linkSchema: closed,
    dataV1: {
        projects: { list: 'projects/list', provisionOptions: 'provision/options', provision: 'projects/provision' },
        branches: { list: 'branches/list', create: 'branches/create', delete: 'branches/delete' },
        query: { readOnly: 'query/read-only' }, connectionSecret: { save: 'connection-secret/save' },
    },
};

function dataManifest() {
    const value = manifest([target, dataTarget]);
    return { ...value, contributes: { ...value.contributes,
        resources: ['projects/list', 'provision/options', 'branches/list'].map(id => ({
            id, source: 'dynamic', kind: 'config', contentType: 'application/json', execution: { target: 'daemon' },
        })),
        actions: [...value.contributes.actions,
            ...['projects/provision', 'branches/create', 'branches/delete', 'query/read-only', 'connection-secret/save'].map(id => ({
                id, title: id, scopes: ['global'], surfaces: ['plugin'], execution: { target: 'daemon' },
                inputSchema: DeploymentTargetRoleInputProtocolSchemasV1[
                    id === 'projects/provision' ? 'projects.provision' : id === 'branches/create' ? 'branches.create'
                        : id === 'branches/delete' ? 'branches.delete' : id === 'query/read-only' ? 'query.readOnly'
                            : 'connectionSecret.save'].jsonSchema, resultSchema: closed,
                dangerLevel: id === 'query/read-only' ? 'safe' : 'writesLocal', readOnly: id === 'query/read-only',
            })),
        ],
    } };
}

describe('deployment target manifest admission', () => {
    it('carries admitted plan facts into the normalized target without dropping provenance', () => {
        const plans = [{ id: 'free', title: 'Free', facts: [{ label: 'Price', value: '$0' }], included: ['Custom domains'],
            source: { url: 'https://example.com/pricing', checkedAt: '2026-11-16' } }];
        const [declared] = admittedTargets(manifest([{ ...target, plans }])).targets;
        const action = { kind: 'plugin', actionId: formatQualifiedPluginActionId({ pluginId: 'example.deploy', localId: 'deploy' }) };
        const normalized = DeploymentTargetV1Schema.parse({ ...declared, v: 1,
            source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'runtime' } },
            actions: { inspect: action, link: action, deploy: action, observe: action } });
        expect(normalized.plans).toEqual(plans);
    });

    it('keeps engine metadata separate from normalized Action and Resource ownership', () => {
        const source = { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'database' } };
        const dataV1 = { database: { engineId: 'example-engine' },
            projects: { list: { kind: 'plugin', resourceId: 'example.deploy/projects/list' } },
            branches: { previewInput: { kind: { kind: 'literal', value: 'preview' },
                actionId: { kind: 'literal', value: 'provider-operand' } } },
            query: { readOnly: { kind: 'plugin', actionId: formatQualifiedPluginActionId({ pluginId: 'example.deploy', localId: 'query/read-only' }) } } };
        const normalized = { ...dataTarget, v: 1, source, dataV1 };
        expect(DeploymentTargetV1Schema.safeParse(normalized).success).toBe(true);
        for (const foreign of [
            { ...dataV1, projects: { list: { kind: 'plugin', resourceId: 'foreign.plugin/projects/list' } } },
            { ...dataV1, query: { readOnly: { kind: 'plugin', actionId: formatQualifiedPluginActionId({ pluginId: 'foreign.plugin', localId: 'query/read-only' }) } } },
        ]) expect(DeploymentTargetV1Schema.safeParse({ ...normalized, dataV1: foreign }).success).toBe(false);
    });

    it('admits read-only exact-resource data project observation for Account and daemon execution', () => {
        for (const execution of [{ target: 'daemon' }, { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } }]) {
            const value = manifest([]);
            const descriptor = { ...dataTarget, dataV1: { projects: { observe: 'projects/observe' } } };
            const action = { id: 'projects/observe', title: 'Observe project', scopes: ['global'], surfaces: ['plugin'], execution,
                inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['projects.observe'].jsonSchema,
                resultSchema: DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema, dangerLevel: 'safe', readOnly: true };
            const authored = { ...value, contributes: { ...value.contributes,
                deploymentTargets: [descriptor], actions: [action] } };
            expect(admittedTargets(authored).targets).toEqual([descriptor]);
            for (const patch of [{ resultSchema: closed }, { dangerLevel: 'writesLocal', readOnly: false }]) {
                expect(admittedTargets({ ...authored, contributes: { ...authored.contributes,
                    actions: [{ ...action, ...patch }] } }).targets).toEqual([]);
            }
        }
    });

    it('admits exact-resource data project deletion for Account and daemon execution', () => {
        for (const execution of [{ target: 'daemon' }, { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } }]) {
            const value = manifest([]);
            const descriptor = { ...dataTarget, dataV1: { projects: { delete: 'projects/delete' } } };
            // The selected data input carries recorded custody; no name operand exists.
            const action = { id: 'projects/delete', title: 'Delete project', scopes: ['global'], surfaces: ['plugin'], execution,
                inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['projects.delete'].jsonSchema,
                resultSchema: DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema, dangerLevel: 'destructive', readOnly: false };
            expect(admittedTargets({ ...value, contributes: { ...value.contributes,
                deploymentTargets: [descriptor], actions: [action] } }).targets).toEqual([descriptor]);
            expect(admittedTargets({ ...value, contributes: { ...value.contributes,
                deploymentTargets: [descriptor], actions: [{ ...action, resultSchema: closed }] } }).targets).toEqual([]);
        }
    });

    it('withdraws lifecycle roles whose closed schemas do not match their canonical input and observation', () => {
        const value = manifest();
        for (const patch of [{ inputSchema: closed }, { resultSchema: closed }]) {
            expect(admittedTargets({ ...value, contributes: { ...value.contributes,
                actions: value.contributes.actions.map(action => action.id === 'deploy' ? { ...action, ...patch } : action),
            } }).targets).toEqual([]);
        }
    });
    it('requires preparation custody while admitting closed product operands and native scope narrowing', () => {
        const value = manifest();
        const canonical = DeploymentTargetRoleInputProtocolSchemasV1.inspect.jsonSchema;
        const product = { ...canonical, properties: { ...canonical.properties,
            product: { type: 'string', enum: ['worker'] },
            providerEnvironment: { type: 'object', properties: { kind: { type: 'string', const: 'production' } },
                required: ['kind'], additionalProperties: false } },
            required: [...canonical.required ?? [], 'product'] };
        const actions = value.contributes.actions.map(action => action.id === 'inspect' ? { ...action, inputSchema: product } : action);
        expect(admittedTargets({ ...value, contributes: { ...value.contributes, actions } }).targets).toEqual([target]);
        for (const inputSchema of [closed, { ...product, required: ['product'] }, { ...product,
            properties: { ...product.properties, credentialPrincipal: closed } }]) {
            expect(admittedTargets({ ...value, contributes: { ...value.contributes,
                actions: actions.map(action => action.id === 'inspect' ? { ...action, inputSchema } : action),
            } }).targets).toEqual([]);
        }
    });
    it('preserves declared optional runtime roles in the normalized public target', () => {
        const action = { kind: 'plugin', actionId: formatQualifiedPluginActionId({ pluginId: 'example.deploy', localId: 'deploy' }) };
        const normalized = DeploymentTargetV1Schema.safeParse({
            ...target, v: 1, id: 'runtime',
            source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'runtime' } },
            actions: { inspect: action, link: action, deploy: action, observe: action,
                cancel: action, variables: { read: action, sync: action }, logs: { runtime: action } },
        });
        expect(normalized.success).toBe(true);
        if (normalized.success) expect(normalized.data.actions).toMatchObject({
            cancel: action, variables: { read: action, sync: action }, logs: { runtime: action },
        });
    });

    it('admits data capabilities beside a runtime without requiring runtime Actions', () => {
        const value = dataManifest();
        expect(admittedTargets(value)).toEqual({ targets: [target, dataTarget], diagnostics: [] });
        const metadataOnly = { ...dataTarget, dataV1: { projects: { list: 'projects/list' } } };
        expect(admittedTargets({ ...value, contributes: { ...value.contributes,
            deploymentTargets: [metadataOnly],
        } }).targets).toEqual([metadataOnly]);
        const { dataV1: _capabilities, ...noCapabilities } = dataTarget;
        expect(admittedTargets({ ...value, contributes: { ...value.contributes,
            deploymentTargets: [noCapabilities],
        } }).targets).toEqual([noCapabilities]);
    });

    it.each([
        ['a missing branch Action', { ...dataTarget, dataV1: { ...dataTarget.dataV1, branches: { create: 'missing' } } }],
        ['an Action used as a Resource', { ...dataTarget, dataV1: { ...dataTarget.dataV1, projects: { list: 'query/read-only' } } }],
        ['a mutation used as a query', { ...dataTarget, dataV1: { ...dataTarget.dataV1, query: { readOnly: 'branches/create' } } }],
        ['a foreign Resource', { ...dataTarget, dataV1: { ...dataTarget.dataV1, projects: { list: 'foreign.plugin/projects/list' } } }],
        ['undeclared provider metadata', { ...dataTarget, dataV1: { ...dataTarget.dataV1, provider: { arbitrary: true } } }],
        ['runtime Actions on a data target', { ...dataTarget, actions: target.actions }],
    ])('withdraws a data target with %s while retaining its healthy sibling', (_reason, invalid) => {
        const value = dataManifest();
        expect(admittedTargets({ ...value, contributes: { ...value.contributes,
            deploymentTargets: [invalid, target],
        } }).targets).toEqual([target]);
    });

    it('withdraws a data target backed by a packaged Resource', () => {
        const value = dataManifest();
        const resources = value.contributes.resources.map(resource => resource.id === 'projects/list'
            ? { id: resource.id, source: 'packaged', kind: resource.kind, contentType: resource.contentType, path: 'projects.json' } : resource);
        expect(admittedTargets({ ...value, contributes: { ...value.contributes, resources } }).targets).toEqual([target]);
    });

    it.each([
        { reason: 'a write effect', patch: { readOnly: false } },
        { reason: 'client placement', patch: { execution: { target: 'client', platforms: ['web'], client: { artifactId: 'client', exportName: 'activate' } } } },
    ])('withdraws a query Action with $reason', ({ patch }) => {
        const value = dataManifest();
        const actions = value.contributes.actions.map(action => action.id === 'query/read-only' ? { ...action, ...patch } : action);
        expect(admittedTargets({ ...value, contributes: { ...value.contributes, actions } }).targets).toEqual([target]);
    });

    it('admits declared runtime roles without a provider unlink or absent optional effects', () => {
        const admitted = admittedTargets(manifest());
        expect(admitted.targets).toEqual([target]);
        expect(admitted.diagnostics).toEqual([]);
    });

    it('withdraws one invalid contributor while retaining its healthy sibling', () => {
        const invalids = [
            { ...target, actions: { ...target.actions, deploy: 'missing' } },
            { ...target, actions: { ...target.actions, deploy: { pluginId: 'foreign.plugin', localId: 'deploy' } } },
            { ...target, actions: { ...target.actions, unlink: 'link' } },
            { ...target, actions: { inspect: 'inspect', link: 'link', deploy: 'deploy' } },
            { ...target, targetSchema: { type: 'object', properties: { nested: { type: 'object' } }, additionalProperties: false } },
        ];
        for (const invalid of invalids) {
            const admitted = admittedTargets(manifest([{ ...invalid, id: 'invalid' }, target]));
            expect(admitted.targets).toEqual([target]);
            expect(admitted.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
                code: 'plugin_contribution_skipped', pluginId: 'example.deploy', contributionId: 'invalid',
            })]));
        }
    });

    it('refuses wrong placement and effect metadata before a target reaches the catalog', () => {
        for (const change of [
            { id: 'inspect', dangerLevel: 'writesLocal' },
            { id: 'deploy', dangerLevel: 'safe' },
            { id: 'inspect', resultSchema: { type: 'object' } },
            { id: 'upload', execution: { target: 'account', account: { artifactId: 'account', exportName: 'activate' } } },
        ]) {
            const value = manifest([{ ...target, actions: { ...target.actions, uploadDeploy: 'upload' } }]);
            const actions = value.contributes.actions.map(action => action.id === change.id ? { ...action, ...change } : action);
            const admitted = PluginContributesV2Schema.safeParse({ ...value.contributes, actions });
            expect(admitted.success).toBe(false);
            if (!admitted.success) expect(admitted.error.issues.some(issue => issue.path[0] === 'deploymentTargets')).toBe(true);
        }
    });
});
