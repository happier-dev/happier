import { expect, it } from 'vitest';
import type { ProjectDefinitionInspectRead } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ProjectEffectiveDefinitionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';
import { selectProjectDefinitionRead } from './projectDefinitionRead';
import { readProjectEffectiveDefinition } from './projectEffectiveDefinition';

const reads = [
    { kind: 'scripts' }, { kind: 'overview', detectedRows: 0 }, { kind: 'rail', detectedRows: 0 },
] as const satisfies readonly ProjectDefinitionInspectRead[];

it.each(reads)('retains authored origins for the $kind consumer without a repository definition', read => {
    const effective: ProjectEffectiveDefinitionV1 = {
        effectiveManifest: { version: 1, scripts: {
            build: { source: { kind: 'command', command: 'echo personal' } },
        } },
        origins: [
            { path: ['scripts', 'build'], layer: 'shared', overridden: true },
            { path: ['scripts', 'build'], layer: 'personal', overridden: false },
        ],
    };
    const selected = selectProjectDefinitionRead({ basis: { kind: 'absent' }, document: null }, {
        entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [],
    }, read, effective);
    expect(selected.effectiveDefinition.effectiveManifest?.scripts?.build).toEqual(effective.effectiveManifest?.scripts?.build);
    expect(selected.definition.document).toBeNull();
    expect(selected.effectiveDefinition.origins).toEqual(effective.origins);
});

it('passes an unaccepted Source setup through the fallback definition reader', () => {
    const setup = { sourceId: 'source', contentRevision: { headerVersion: 1, bodyVersion: 2 }, digest: 'a'.repeat(64) };
    const selected = selectProjectDefinitionRead({ basis: { kind: 'absent' }, document: null }, {
        entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [],
    }, { kind: 'scripts' }, undefined, {
        source: { id: 'source', name: 'Acme dev setup' }, setup,
        manifest: { version: 1, scripts: { check: { source: { kind: 'command', command: 'echo check' } } } },
    });
    expect(selected.effectiveDefinition.pendingSharedSetup).toEqual({
        source: { id: 'source', name: 'Acme dev setup' }, setup,
        summary: [{ kind: 'scripts', count: 1 }],
    });
});

it('passes an unaccepted Source setup through the effective definition reader', async () => {
    const setup = { sourceId: 'source', contentRevision: { headerVersion: 1, bodyVersion: 2 }, digest: 'b'.repeat(64) };
    const result = await readProjectEffectiveDefinition({ root: '/unused',
        account: { credentials: { token: 'fixture', encryption: null } }, project: { serverId: 'home', projectId: 'project' },
        serverHttpBaseUrl: 'https://requester.example', acceptedSetup: { kind: 'ready' },
        repositorySnapshot: { basis: { kind: 'absent' }, document: null }, pendingSharedSetup: {
            source: { id: 'source', name: 'Acme dev setup' }, setup,
            manifest: { version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } },
        },
    });
    expect(result.effectiveDefinition.pendingSharedSetup).toEqual({
        source: { id: 'source', name: 'Acme dev setup' }, setup,
        summary: [{ kind: 'workspaceSetup', count: 1 }],
    });
});
