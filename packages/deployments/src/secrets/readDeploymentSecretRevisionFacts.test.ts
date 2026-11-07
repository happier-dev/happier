import { expect, it } from 'vitest';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { readDeploymentSecretRevisionFacts } from './readDeploymentSecretRevisionFacts.js';

const ref = 'happier:shared-secret:v1:credential';
const savedSecretRevisions = [{ resourceId: 'credential', revision: 2 }];
const binding = (name: string, resourceRevision: number, phase: 'build' | 'runtime' = 'runtime'): EnvironmentSecretBindingV1 => ({
    purpose: 'variable', name, phase, source: { kind: 'secret', ref, resourceRevision },
});

it('compares the active launch revision with current metadata even when the saved binding is stale', () => {
    const bindings = [binding('TOKEN', 1), binding('SECOND_USE', 1)];
    expect(readDeploymentSecretRevisionFacts({ bindings, runningBindings: bindings, savedSecretRevisions })).toEqual([
        { name: 'TOKEN', phase: 'runtime', ref, runningRevision: 1, currentRevision: 2, status: 'redeploy_required' },
        { name: 'SECOND_USE', phase: 'runtime', ref, runningRevision: 1, currentRevision: 2, status: 'redeploy_required' },
    ]);
});

it('does not infer actual build revisions from a promoted image destination approval', () => {
    const bindings = [binding('BUILD_TOKEN', 2, 'build'), binding('RUNTIME_TOKEN', 2)];
    expect(readDeploymentSecretRevisionFacts({ bindings, runningBindings: bindings, savedSecretRevisions })).toEqual([
        { name: 'BUILD_TOKEN', phase: 'build', ref, runningRevision: null, currentRevision: 2,
            status: 'unknown', reason: 'build_secret_revision_unrecorded' },
        { name: 'RUNTIME_TOKEN', phase: 'runtime', ref, runningRevision: 2, currentRevision: 2, status: 'unchanged' },
    ]);
});

it('distinguishes missing launch evidence, missing current metadata and withdrawn access', () => {
    const bindings = [binding('TOKEN', 2)];
    expect(readDeploymentSecretRevisionFacts({ bindings, savedSecretRevisions })).toMatchObject([
        { status: 'unknown', runningRevision: null, currentRevision: 2, reason: 'running_secret_revision_unrecorded' },
    ]);
    expect(readDeploymentSecretRevisionFacts({ bindings, runningBindings: bindings })).toMatchObject([
        { status: 'unknown', runningRevision: 2, currentRevision: null, reason: 'saved_secret_revision_unrecorded' },
    ]);
    expect(readDeploymentSecretRevisionFacts({ bindings, runningBindings: bindings, savedSecretRevisions: [] })).toMatchObject([
        { status: 'unavailable', runningRevision: 2, currentRevision: null, reason: 'saved_secret_unavailable' },
    ]);
    const replacement = binding('TOKEN', 1);
    if (replacement.source.kind !== 'secret') throw new Error('Expected secret fixture');
    const changedReference = { ...replacement, source: { ...replacement.source, ref: 'happier:shared-secret:v1:replacement' } };
    expect(readDeploymentSecretRevisionFacts({ bindings, runningBindings: [changedReference], savedSecretRevisions })).toMatchObject([
        { status: 'unknown', runningRevision: null },
    ]);
});
