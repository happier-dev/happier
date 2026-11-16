import { describe, expect, it } from 'vitest';
import { OWN_SERVER_DEPLOYMENT_TARGET_V1, OWN_SERVER_DEPLOYMENT_TARGET_SOURCE_V1, projectDeploymentSuggestionTargetsV1, selectDeploymentTargetTeardownAvailableV1, selectDeploymentTargetRemovalChoicesV1 } from './deploymentTargetCatalog.js';
import { listDeploymentTargetsV1 } from './deploymentTargetCatalog.js';

it('preserves a contributed database engine while qualifying only executable references', () => {
    const closed = { type: 'object' as const, properties: {}, additionalProperties: false };
    const targets = listDeploymentTargetsV1([{
        pluginId: 'com.example.data', identity: { pluginId: 'com.example.data', localId: 'database' },
        definition: { id: 'database', role: 'data', title: 'Data', icon: 'server-outline', targetKind: 'example',
            targetSchema: closed, linkSchema: closed,
            dataV1: { database: { engineId: 'example-engine' }, projects: { list: 'projects' } } },
    }]);
    expect(targets.find(target => target.role === 'data')?.dataV1).toEqual({
        database: { engineId: 'example-engine' },
        projects: { list: { kind: 'plugin', resourceId: 'com.example.data/projects' } },
    });
});

it('carries the host repository source routes into the suggestion catalog', () => {
    const catalog = projectDeploymentSuggestionTargetsV1([OWN_SERVER_DEPLOYMENT_TARGET_V1]);
    expect(catalog.targets[0]?.sources).toEqual({ gitIntegration: ['github', 'gitlab', 'bitbucket', 'azure-devops'], upload: false });
});

it('defaults linked and legacy resources to unlink and offers provider delete only when declared', () => {
    const source = { kind: 'plugin', contribution: { pluginId: 'provider', localId: 'runtime' } } as const;
    const targets = [{ pluginId: 'provider', targetId: 'runtime', teardown: true as const }];
    expect(selectDeploymentTargetRemovalChoicesV1(source, targets)).toEqual({ choices: ['unlink', 'delete'], defaultChoice: 'unlink' });
    expect(selectDeploymentTargetRemovalChoicesV1(source, targets, 'created')).toEqual({ choices: ['unlink', 'delete'], defaultChoice: 'delete' });
    expect(selectDeploymentTargetRemovalChoicesV1(source, [], 'created')).toEqual({ choices: ['unlink'], defaultChoice: 'unlink' });
});

describe('target teardown availability', () => {
    it('uses the declared role for the exact target while keeping native removal available', () => {
        const source = { kind: 'plugin', contribution: { pluginId: 'provider', localId: 'runtime' } } as const;
        expect(selectDeploymentTargetTeardownAvailableV1(source, [])).toBe(false);
        expect(selectDeploymentTargetTeardownAvailableV1(source, [{ pluginId: 'provider', targetId: 'runtime' }])).toBe(false);
        expect(selectDeploymentTargetTeardownAvailableV1(source,
            [{ pluginId: 'provider', targetId: 'other-runtime', teardown: true }])).toBe(false);
        expect(selectDeploymentTargetTeardownAvailableV1(source,
            [{ pluginId: 'other-provider', targetId: 'runtime', teardown: true }])).toBe(false);
        expect(selectDeploymentTargetTeardownAvailableV1(source,
            [{ pluginId: 'provider', targetId: 'runtime', teardown: true }])).toBe(true);
        expect(selectDeploymentTargetTeardownAvailableV1(OWN_SERVER_DEPLOYMENT_TARGET_SOURCE_V1, [])).toBe(true);
        expect(selectDeploymentTargetTeardownAvailableV1({ kind: 'host', id: 'unknown-host' }, [])).toBe(false);
        expect(selectDeploymentTargetTeardownAvailableV1(undefined, [])).toBe(true);
    });
});
