import { describe, expect, it } from 'vitest';

import {
  projectPackedAdmittedContributors,
  type PackedPluginTestParticipant,
  type PackedPluginTestTargetedAdmission,
} from './packedTest';

function participant(
  pluginId: string,
  appliedGeneration: string | null,
  desiredGeneration = appliedGeneration ?? `${pluginId}-generation-desired`,
): PackedPluginTestParticipant {
  return {
    source: { kind: 'project', locator: `/fixtures/${pluginId}` },
    plugin: {
      id: pluginId,
      version: '1.0.0',
      packageIdentity: { name: null, version: '1.0.0' },
    },
    archive: { digest: `sha256-${pluginId}`, integrity: `sha256-${pluginId}` },
    admission: {
      decision: 'installAndTrust',
      desiredGeneration,
      appliedGeneration,
    },
  };
}

describe('projectPackedAdmittedContributors', () => {
  it('rejects a target snapshot that attributes a prerequisite plugin at a stale immutable generation', () => {
    const contributor = participant('acme.contributor', 'contributor-generation-current');
    const admissions: readonly PackedPluginTestTargetedAdmission[] = [{
      target: {
        pluginId: 'acme.target',
        pointId: 'providers',
        immutableGenerationId: 'target-generation-current',
      },
      protocol: { id: 'packed-targeted-provider', version: 1 },
      contributor: {
        pluginId: contributor.plugin.id,
        contributionId: 'provider-a',
        immutableGenerationId: 'contributor-generation-stale',
      },
    }];

    expect(projectPackedAdmittedContributors({
      prerequisites: [contributor],
      admissions,
    })).toEqual({
      ok: false,
      code: 'plugin_packed_targeted_admission_generation_mismatch',
      message: "Disposable daemon admitted 'acme.contributor' at immutable generation 'contributor-generation-stale', not its current applied prerequisite generation",
    });
  });

  it('keeps an installed but unadmitted prerequisite out of contributors while retaining the current admitted one', () => {
    const contributor = participant('acme.contributor', 'contributor-generation-current');
    const unrelated = participant('acme.unrelated', 'unrelated-generation-current');
    const contributorAppliedGeneration = contributor.admission.appliedGeneration;
    if (contributorAppliedGeneration === null) throw new Error('Expected a current contributor generation');
    const admission: PackedPluginTestTargetedAdmission = {
      target: {
        pluginId: 'acme.target',
        pointId: 'providers',
        immutableGenerationId: 'target-generation-current',
      },
      protocol: { id: 'packed-targeted-provider', version: 1 },
      contributor: {
        pluginId: contributor.plugin.id,
        contributionId: 'provider-a',
        immutableGenerationId: contributorAppliedGeneration,
      },
    };

    expect(projectPackedAdmittedContributors({
      prerequisites: [contributor, unrelated],
      admissions: [admission],
    })).toEqual({
      ok: true,
      contributors: [{
        ...contributor,
        targetedAdmissions: [admission],
      }],
    });
  });

  it('does not turn an inert prerequisite desired generation into targeted execution authority', () => {
    const inert = participant('acme.inert', null, 'inert-generation-committed');
    const admission: PackedPluginTestTargetedAdmission = {
      target: {
        pluginId: 'acme.target',
        pointId: 'providers',
        immutableGenerationId: 'target-generation-current',
      },
      protocol: { id: 'packed-targeted-provider', version: 1 },
      contributor: {
        pluginId: inert.plugin.id,
        contributionId: 'provider-a',
        immutableGenerationId: inert.admission.desiredGeneration,
      },
    };

    expect(projectPackedAdmittedContributors({
      prerequisites: [inert],
      admissions: [admission],
    })).toEqual({
      ok: false,
      code: 'plugin_packed_targeted_admission_generation_mismatch',
      message: "Disposable daemon admitted 'acme.inert' at immutable generation 'inert-generation-committed', not its current applied prerequisite generation",
    });
  });
});
