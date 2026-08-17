import { describe, expect, it } from 'vitest';

import {
  derivePluginUiTargetedSurfaceMountInstanceKeyV1,
  PluginTargetedContributionSelectionV1Schema,
  PluginUiTargetedContributionsV1Schema,
} from './targetedContributions.js';

const admittedSnapshot = {
  target: {
    pluginId: 'acme.target',
    immutableGenerationId: 'target-generation-a',
  },
  points: [{
    pointId: 'connection',
    protocols: [{
      protocol: { id: 'connection', version: 1 },
      contributions: [{
        contributor: {
          pluginId: 'acme.provider',
          contributionId: 'github-connection',
          immutableGenerationId: 'provider-generation-a',
        },
        protocol: { id: 'connection', version: 1 },
        descriptor: { providerId: 'github' },
        operations: [{
          point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
          contributor: {
            pluginId: 'acme.provider',
            contributionId: 'github-connection',
            immutableGenerationId: 'provider-generation-a',
          },
          role: 'connectionTest',
          action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
        }],
        surfaces: [{
          point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
          contributor: {
            pluginId: 'acme.provider',
            contributionId: 'github-connection',
            immutableGenerationId: 'provider-generation-a',
          },
          role: 'detail',
          presentation: 'content',
        }],
      }],
    }],
  }],
} as const;

describe('targeted Host API contribution projection', () => {
  it('derives one deterministic, opaque mount identity from the logical targeted Surface entry', () => {
    const surface = admittedSnapshot.points[0].protocols[0].contributions[0].surfaces[0];
    const base = {
      targetPluginId: admittedSnapshot.target.pluginId,
      surface,
      rawInstanceKey: 'entry-42',
    } as const;

    const key = derivePluginUiTargetedSurfaceMountInstanceKeyV1(base);
    expect(key).toMatch(/^targeted-surface:v1:[a-f0-9]{64}$/u);
    expect(key).not.toBe(base.rawInstanceKey);
    expect(derivePluginUiTargetedSurfaceMountInstanceKeyV1(base)).toBe(key);
    expect(derivePluginUiTargetedSurfaceMountInstanceKeyV1({
      ...base,
      surface: {
        ...surface,
        contributor: { ...surface.contributor, immutableGenerationId: 'provider-generation-b' },
      },
    })).toBe(key);

    const distinct = new Set([
      key,
      derivePluginUiTargetedSurfaceMountInstanceKeyV1({
        ...base,
        targetPluginId: 'acme.other-target',
      }),
      derivePluginUiTargetedSurfaceMountInstanceKeyV1({
        ...base,
        surface: {
          ...surface,
          point: { ...surface.point, pointId: 'connection-summary' },
        },
      }),
      derivePluginUiTargetedSurfaceMountInstanceKeyV1({
        ...base,
        surface: {
          ...surface,
          point: {
            ...surface.point,
            protocol: { ...surface.point.protocol, version: 2 },
          },
        },
      }),
      derivePluginUiTargetedSurfaceMountInstanceKeyV1({
        ...base,
        surface: {
          ...surface,
          contributor: { ...surface.contributor, contributionId: 'gitlab-connection' },
        },
      }),
      derivePluginUiTargetedSurfaceMountInstanceKeyV1({
        ...base,
        surface: { ...surface, role: 'summary' },
      }),
      derivePluginUiTargetedSurfaceMountInstanceKeyV1({ ...base, rawInstanceKey: 'entry-43' }),
      derivePluginUiTargetedSurfaceMountInstanceKeyV1({
        ...base,
        rawInstanceKey: 'entry\u0000summary',
      }),
      derivePluginUiTargetedSurfaceMountInstanceKeyV1({
        ...base,
        rawInstanceKey: 'entry-summary',
      }),
      derivePluginUiTargetedSurfaceMountInstanceKeyV1({ ...base, rawInstanceKey: 'caf\u00e9' }),
      derivePluginUiTargetedSurfaceMountInstanceKeyV1({ ...base, rawInstanceKey: 'cafe\u0301' }),
    ]);
    expect(distinct).toHaveLength(11);

    const defaulted = derivePluginUiTargetedSurfaceMountInstanceKeyV1({
      targetPluginId: base.targetPluginId,
      surface,
    });
    expect(derivePluginUiTargetedSurfaceMountInstanceKeyV1({
      targetPluginId: base.targetPluginId,
      surface,
    })).toBe(defaulted);
    expect(defaulted).not.toBe(key);
  });

  it('keeps qualified protocol identity admission aligned with portable selection parsing', () => {
    const selection = {
      target: admittedSnapshot.target,
      point: {
        pointId: admittedSnapshot.points[0].pointId,
        protocol: { id: 'happier.channels/providers', version: 1 },
      },
      contributor: admittedSnapshot.points[0].protocols[0].contributions[0].contributor,
    } as const;

    expect(PluginTargetedContributionSelectionV1Schema.parse(selection)).toEqual(selection);
    for (const id of [
      'happier.channels.providers',
      'happier..channels/providers',
      'happier.channels//providers',
    ]) {
      expect(PluginTargetedContributionSelectionV1Schema.safeParse({
        ...selection,
        point: { ...selection.point, protocol: { id, version: 1 } },
      }).success, id).toBe(false);
    }
  });

  it('keeps the portable selection closed and non-executable', () => {
    const selection = {
      target: admittedSnapshot.target,
      point: admittedSnapshot.points[0].protocols[0].contributions[0].operations[0].point,
      contributor: admittedSnapshot.points[0].protocols[0].contributions[0].contributor,
    } as const;

    expect(PluginTargetedContributionSelectionV1Schema.parse(selection)).toEqual(selection);
    expect(PluginTargetedContributionSelectionV1Schema.safeParse({
      ...selection,
      action: admittedSnapshot.points[0].protocols[0].contributions[0].operations[0].action,
    }).success).toBe(false);
    expect(PluginTargetedContributionSelectionV1Schema.safeParse({
      ...selection,
      role: admittedSnapshot.points[0].protocols[0].contributions[0].operations[0].role,
    }).success).toBe(false);
    expect(PluginTargetedContributionSelectionV1Schema.safeParse({
      ...selection,
      target: { pluginId: selection.target.pluginId },
    }).success).toBe(false);
    expect(PluginTargetedContributionSelectionV1Schema.safeParse({
      ...selection,
      contributor: {
        pluginId: selection.contributor.pluginId,
        contributionLocalId: selection.contributor.contributionId,
        immutableGenerationId: selection.contributor.immutableGenerationId,
      },
    }).success).toBe(false);
  });

  it('rejects whitespace-padded immutable identities instead of rewriting their closed bytes', () => {
    const selection = {
      target: admittedSnapshot.target,
      point: admittedSnapshot.points[0].protocols[0].contributions[0].operations[0].point,
      contributor: admittedSnapshot.points[0].protocols[0].contributions[0].contributor,
    } as const;

    expect(PluginTargetedContributionSelectionV1Schema.safeParse({
      ...selection,
      target: {
        ...selection.target,
        immutableGenerationId: ` ${selection.target.immutableGenerationId} `,
      },
    }).success).toBe(false);
    expect(PluginTargetedContributionSelectionV1Schema.safeParse({
      ...selection,
      contributor: {
        ...selection.contributor,
        immutableGenerationId: ` ${selection.contributor.immutableGenerationId} `,
      },
    }).success).toBe(false);
  });

  it('admits only an exact, target-scoped immutable snapshot', () => {
    expect(PluginUiTargetedContributionsV1Schema.parse(admittedSnapshot)).toEqual(admittedSnapshot);
  });

  it('enforces the target-point, contributor, and operation ceilings instead of accepting an unbounded cross-realm catalog', () => {
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: Array.from({ length: 17 }, (_, index) => ({
        ...admittedSnapshot.points[0],
        pointId: `connection-${index}`,
      })),
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [],
      }],
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [{
          ...admittedSnapshot.points[0].protocols[0],
          contributions: Array.from({ length: 128 }, (_, index) => ({
            ...admittedSnapshot.points[0].protocols[0].contributions[0],
            contributor: {
              ...admittedSnapshot.points[0].protocols[0].contributions[0].contributor,
              contributionId: `first-${String(index).padStart(3, '0')}`,
            },
            operations: [],
          })),
        }, {
          ...admittedSnapshot.points[0].protocols[0],
          protocol: { id: 'connection', version: 2 },
          contributions: Array.from({ length: 129 }, (_, index) => ({
            ...admittedSnapshot.points[0].protocols[0].contributions[0],
            protocol: { id: 'connection', version: 2 },
            contributor: {
              ...admittedSnapshot.points[0].protocols[0].contributions[0].contributor,
              contributionId: `second-${String(index).padStart(3, '0')}`,
            },
            operations: [],
          })),
        }],
      }],
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [{
          ...admittedSnapshot.points[0].protocols[0],
          contributions: [{
            ...admittedSnapshot.points[0].protocols[0].contributions[0],
            operations: [],
          }],
        }],
      }],
    }).success).toBe(true);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [{
          ...admittedSnapshot.points[0].protocols[0],
          contributions: Array.from({ length: 257 }, () => admittedSnapshot.points[0].protocols[0].contributions[0]),
        }],
      }],
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [{
          ...admittedSnapshot.points[0].protocols[0],
          contributions: [{
            ...admittedSnapshot.points[0].protocols[0].contributions[0],
            operations: Array.from({ length: 17 }, (_, index) => ({
              ...admittedSnapshot.points[0].protocols[0].contributions[0].operations[0],
              role: `role-${index}`,
            })),
          }],
        }],
      }],
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: Array.from({ length: 5 }, (_, index) => ({
          ...admittedSnapshot.points[0].protocols[0],
          protocol: { id: 'connection', version: index + 1 },
          contributions: [],
        })),
      }],
    }).success).toBe(false);
  });

  it('rejects point/protocol drift plus roles and operation handles that do not exactly belong to their admitted contributor generation', () => {
    const point = admittedSnapshot.points[0];
    const protocol = point.protocols[0];
    const contribution = protocol.contributions[0];
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...point,
        protocols: [{
          ...protocol,
          contributions: [{
            ...contribution,
            operations: [contribution.operations[0], contribution.operations[0]],
          }],
        }],
      }],
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...point,
        protocols: [{
          ...protocol,
          contributions: [{
            ...contribution,
            operations: [{
              ...contribution.operations[0],
              action: { pluginId: 'acme.other', localId: 'connection/prepare-v1' },
            }],
          }],
        }],
      }],
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...point,
        protocols: [{
          ...protocol,
          contributions: [{
            ...contribution,
            operations: [{
              ...contribution.operations[0],
              contributor: {
                ...contribution.operations[0].contributor,
                immutableGenerationId: 'provider-generation-b',
              },
            }],
          }],
        }],
      }],
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...point,
        protocols: [{
          ...protocol,
          protocol: { id: 'other', version: 1 },
        }],
      }],
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...point,
        protocols: [{
          ...protocol,
          contributions: [{
            ...contribution,
            surfaces: [{
              ...contribution.surfaces[0],
              contributor: {
                ...contribution.surfaces[0].contributor,
                immutableGenerationId: 'provider-generation-b',
              },
            }],
          }],
        }],
      }],
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...point,
        protocols: [{
          ...protocol,
          contributions: [{
            ...contribution,
            surfaces: [{
              ...contribution.surfaces[0],
              point: { pointId: 'other', protocol: contribution.surfaces[0].point.protocol },
            }],
          }],
        }],
      }],
    }).success).toBe(false);
  });

  it('projects a normalized target-owned JSON descriptor while keeping host-private mount facts out', () => {
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [{
          ...admittedSnapshot.points[0].protocols[0],
          contributions: [{
            ...admittedSnapshot.points[0].protocols[0].contributions[0],
            descriptor: Number.POSITIVE_INFINITY,
          }],
        }],
      }],
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      target: {
        ...admittedSnapshot.target,
        materializationId: 'runtime-materialization',
      },
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [{
          ...admittedSnapshot.points[0].protocols[0],
          contributions: [{
            ...admittedSnapshot.points[0].protocols[0].contributions[0],
            surfaces: [{
              ...admittedSnapshot.points[0].protocols[0].contributions[0].surfaces[0],
              inputSchema: { type: 'object' },
              renderer: 'private-renderer',
            }],
          }],
        }],
      }],
    }).success).toBe(false);
  });

  it('requires an explicit empty Surface family when a current contribution has no admitted Surface roles', () => {
    const contribution = admittedSnapshot.points[0].protocols[0].contributions[0];
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [{
          ...admittedSnapshot.points[0].protocols[0],
          contributions: [{
            ...contribution,
            surfaces: [],
          }],
        }],
      }],
    }).success).toBe(true);
    const withoutSurfaces = {
      ...contribution,
    } as Record<string, unknown>;
    delete withoutSurfaces.surfaces;
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [{
          ...admittedSnapshot.points[0].protocols[0],
          contributions: [withoutSurfaces],
        }],
      }],
    }).success).toBe(false);
  });
});
