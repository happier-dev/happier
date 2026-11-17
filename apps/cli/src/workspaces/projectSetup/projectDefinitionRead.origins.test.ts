import { expect, it } from 'vitest';
import type { ProjectDefinitionInspectRead } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ProjectEffectiveDefinitionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';
import { selectProjectDefinitionRead } from './projectDefinitionRead';

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
