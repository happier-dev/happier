import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import { DeploymentTargetV1Schema } from './target.js';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { DeploymentTargetFailureTransitionV1ProtocolSchema, DeploymentTargetRoleInputProtocolSchemasV1,
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
    it('admits exactly the declared same-plugin failure Event payload and isolates a bad descriptor', () => {
        const failureTransitionEvent = 'failure-transition';
        const declared = { ...target, id: 'with-failure-event', failureTransitionEvent };
        const event = { id: failureTransitionEvent, kind: 'event', title: 'Deployment transition',
            payloadSchema: DeploymentTargetFailureTransitionV1ProtocolSchema.jsonSchema };
        const value = manifest([declared, target]);
        const withEvents = { ...value, contributes: { ...value.contributes, events: [event] } };
        expect(admittedTargets(withEvents).targets).toEqual([declared, target]);
        for (const events of [[], [{ ...event, payloadSchema: closed }], [{ ...event,
            payloadSchema: { ...event.payloadSchema, additionalProperties: true } }]]) {
            expect(admittedTargets({ ...withEvents, contributes: { ...withEvents.contributes, events } }).targets).toEqual([target]);
        }
        expect(admittedTargets({ ...withEvents, contributes: { ...withEvents.contributes,
            deploymentTargets: [{ ...declared, failureTransitionEvent: 'foreign.plugin/failure-transition' }, target],
        } }).targets).toEqual([target]);
    });
    it('retains a qualified failure Event on its runtime target and rejects another plugin Event', () => {
        const action = { kind: 'plugin', actionId: formatQualifiedPluginActionId({ pluginId: 'example.deploy', localId: 'deploy' }) };
        const normalized = { ...target, v: 1,
            source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'runtime' } },
            actions: { inspect: action, link: action, deploy: action, observe: action },
            failureTransitionEvent: 'example.deploy/failure-transition' };
        expect(DeploymentTargetV1Schema.safeParse(normalized).success).toBe(true);
        expect(DeploymentTargetV1Schema.safeParse({ ...normalized,
            failureTransitionEvent: 'foreign.plugin/failure-transition' }).success).toBe(false);
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

    it('withdraws data targets with missing or wrong-kind refs and mismatched query effects', () => {
        const value = dataManifest();
        for (const invalid of [
            { ...dataTarget, dataV1: { ...dataTarget.dataV1, branches: { create: 'missing' } } },
            { ...dataTarget, dataV1: { ...dataTarget.dataV1, projects: { list: 'query/read-only' } } },
            { ...dataTarget, dataV1: { ...dataTarget.dataV1, query: { readOnly: 'branches/create' } } },
            { ...dataTarget, dataV1: { ...dataTarget.dataV1, projects: { list: 'foreign.plugin/projects/list' } } },
            { ...dataTarget, dataV1: { ...dataTarget.dataV1, provider: { arbitrary: true } } },
            { ...dataTarget, actions: target.actions },
        ]) {
            expect(admittedTargets({ ...value, contributes: { ...value.contributes,
                deploymentTargets: [invalid, target],
            } }).targets).toEqual([target]);
        }
        const resources = value.contributes.resources.map(resource => resource.id === 'projects/list'
            ? { id: resource.id, source: 'packaged', kind: resource.kind, contentType: resource.contentType, path: 'projects.json' } : resource);
        expect(admittedTargets({ ...value, contributes: { ...value.contributes, resources } }).targets).toEqual([target]);
        for (const patch of [{ readOnly: false }, { execution: { target: 'client', platforms: ['web'], client: { artifactId: 'client', exportName: 'activate' } } }]) {
            const actions = value.contributes.actions.map(action => action.id === 'query/read-only' ? { ...action, ...patch } : action);
            expect(admittedTargets({ ...value, contributes: { ...value.contributes, actions } }).targets).toEqual([target]);
        }
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
