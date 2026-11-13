import { describe, expect, it } from 'vitest';

import {
  derivePluginUiTargetedSurfaceMountInstanceKeyV1,
  PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1,
  PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1,
  PluginTargetedContributionSelectionV1Schema,
  PluginUiTargetedContributionsV1Schema,
  projectPluginUiTargetedContributionsV1,
  selectPluginUiTargetedContributionOperationV1,
  selectPluginUiTargetedContributionSurfaceV1,
  selectPluginUiTargetedContributionV1,
} from './targetedContributions.js';

const admittedSnapshot = {
  target: {
    pluginId: 'acme.target',
    occurrenceId: 'target-occurrence-a',
    sourceCustody: {
      kind: 'development',
      registeredRootId: 'target-root',
    },
  },
  points: [{
    pointId: 'connection',
    protocols: [{
      protocol: { id: 'connection', version: 1 },
      contributions: [{
        contributor: {
          pluginId: 'acme.provider',
          contributionId: 'github-connection',
          occurrenceId: 'provider-occurrence-a',
          sourceCustody: {
            kind: 'bundled_first_party',
            packagedRuntime: {
              kind: 'cli_version_root',
              versionRootId: 'cli-version-a',
            },
          },
        },
        protocol: { id: 'connection', version: 1 },
        descriptor: { providerId: 'github' },
        operations: [{
          point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
          contributor: {
            pluginId: 'acme.provider',
            contributionId: 'github-connection',
            occurrenceId: 'provider-occurrence-a',
            sourceCustody: {
              kind: 'bundled_first_party',
              packagedRuntime: {
                kind: 'cli_version_root',
                versionRootId: 'cli-version-a',
              },
            },
          },
          role: 'connectionTest',
          action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
        }],
        surfaces: [{
          point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
          contributor: {
            pluginId: 'acme.provider',
            contributionId: 'github-connection',
            occurrenceId: 'provider-occurrence-a',
            sourceCustody: {
              kind: 'bundled_first_party',
              packagedRuntime: {
                kind: 'cli_version_root',
                versionRootId: 'cli-version-a',
              },
            },
          },
          role: 'detail',
          presentation: 'content',
        }],
      }],
    }],
  }],
} as const;

describe('targeted Host API contribution projection', () => {
  it('projects admitted contributor order into the strict wire order across prefix plugin ids', () => {
    const original = admittedSnapshot.points[0].protocols[0].contributions[0];
    // Admission compares its own keys with localeCompare. With a prefix plugin
    // id, that order can differ from the wire's ordinal identity tuple order.
    const contributions = ['acme.provider.qa', 'acme.provider'].map(pluginId => ({
      contributor: { ...original.contributor, pluginId, contributionId: 'source' },
      protocol: original.protocol,
      descriptor: { pluginId },
      operations: [],
      surfaces: [],
    }));
    const snapshot = projectPluginUiTargetedContributionsV1({
      target: admittedSnapshot.target,
      snapshots: [{
        point: { pointId: 'connection', protocol: original.protocol },
        snapshot: { target: { ...admittedSnapshot.target, pointId: 'connection' }, contributions },
      }],
      readSourceCustody: () => original.contributor.sourceCustody,
    });
    expect(PluginUiTargetedContributionsV1Schema.parse(snapshot).points[0]?.protocols[0]?.contributions
      .map(contribution => contribution.contributor.pluginId)).toEqual(['acme.provider', 'acme.provider.qa']);
    expect(contributions.map(contribution => contribution.contributor.pluginId))
      .toEqual(['acme.provider.qa', 'acme.provider']);
  });

  it('projects each admitted role with its own physical occurrence and custody', () => {
    const source = admittedSnapshot.points[0].protocols[0].contributions[0];
    const accountCustody = {
      kind: 'account_release', pluginId: source.contributor.pluginId,
      version: '1.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
    } as const;
    const machineContributor = { ...source.contributor, occurrenceId: 'machine-source-current' };
    const machineCustody = { kind: 'development', registeredRootId: 'machine-root' } as const;
    const snapshot = projectPluginUiTargetedContributionsV1({
      target: admittedSnapshot.target,
      snapshots: [{
        point: { pointId: 'connection', protocol: source.protocol },
        snapshot: {
          target: { ...admittedSnapshot.target, pointId: 'connection' },
          contributions: [{
            ...source,
            descriptor: { providerId: 'github', kinds: ['personal', 'external'] as const },
            operations: [{ ...source.operations[0], contributor: machineContributor }],
            surfaces: [{ ...source.surfaces[0], contributor: machineContributor }],
          }],
        },
      }],
      readSourceCustody: (pluginId, occurrenceId) => pluginId === admittedSnapshot.target.pluginId
        ? admittedSnapshot.target.sourceCustody
        : occurrenceId === machineContributor.occurrenceId ? machineCustody : accountCustody,
    });
    const parsed = PluginUiTargetedContributionsV1Schema.parse(snapshot);
    const selector = {
      pointId: 'connection', protocol: source.protocol,
      contributor: { pluginId: source.contributor.pluginId, contributionId: source.contributor.contributionId },
    };
    expect(selectPluginUiTargetedContributionV1(parsed, selector)?.contributor.sourceCustody).toEqual(accountCustody);
    expect(selectPluginUiTargetedContributionV1(parsed, selector)?.descriptor).toEqual({
      providerId: 'github', kinds: ['personal', 'external'],
    });
    expect(selectPluginUiTargetedContributionOperationV1(parsed, {
      ...selector, role: source.operations[0].role,
    })?.contributor).toEqual({ ...machineContributor, sourceCustody: machineCustody });
    expect(selectPluginUiTargetedContributionSurfaceV1(parsed, {
      ...selector, role: source.surfaces[0].role,
    })?.contributor).toEqual({ ...machineContributor, sourceCustody: machineCustody });
  });

  it('admits exact role occurrences distinct from their Account descriptor parent without crossing contribution identity', () => {
    const original = admittedSnapshot.points[0].protocols[0].contributions[0];
    const role = { ...original.operations[0], contributor: { ...original.contributor,
      occurrenceId: 'machine-source-current', sourceCustody: { kind: 'development' as const, registeredRootId: 'machine-root' },
    } };
    const project = (operation: typeof role) => ({ ...admittedSnapshot, points: [{ ...admittedSnapshot.points[0], protocols: [{
      ...admittedSnapshot.points[0].protocols[0], contributions: [{ ...original, operations: [operation] }],
    }] }] });
    const parsed = PluginUiTargetedContributionsV1Schema.parse(project(role));
    expect(selectPluginUiTargetedContributionOperationV1(parsed, {
      pointId: role.point.pointId, protocol: role.point.protocol,
      contributor: { pluginId: original.contributor.pluginId, contributionId: original.contributor.contributionId }, role: role.role,
    })).toEqual(role);
    for (const contributor of [
      { ...role.contributor, pluginId: 'acme.other' },
      { ...role.contributor, contributionId: 'other-source' },
    ]) expect(PluginUiTargetedContributionsV1Schema.safeParse(project({ ...role, contributor })).success).toBe(false);
  });

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
        contributor: { ...surface.contributor, occurrenceId: 'provider-occurrence-b' },
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
      target: {
        pluginId: admittedSnapshot.target.pluginId,
        sourceCustody: { kind: 'development', registeredRootId: 'target-root' },
      },
      point: {
        pointId: admittedSnapshot.points[0].pointId,
        protocol: { id: 'happier.channels/providers', version: 1 },
      },
      contributor: {
        pluginId: admittedSnapshot.points[0].protocols[0].contributions[0].contributor.pluginId,
        contributionId: admittedSnapshot.points[0].protocols[0].contributions[0].contributor.contributionId,
        sourceCustody: { kind: 'development', registeredRootId: 'provider-root' },
      },
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
      target: {
        pluginId: admittedSnapshot.target.pluginId,
        sourceCustody: { kind: 'development', registeredRootId: 'target-root' },
      },
      point: admittedSnapshot.points[0].protocols[0].contributions[0].operations[0].point,
      contributor: {
        pluginId: admittedSnapshot.points[0].protocols[0].contributions[0].contributor.pluginId,
        contributionId: admittedSnapshot.points[0].protocols[0].contributions[0].contributor.contributionId,
        sourceCustody: { kind: 'development', registeredRootId: 'provider-root' },
      },
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
        sourceCustody: selection.contributor.sourceCustody,
      },
    }).success).toBe(false);
  });

  it('reuses the canonical strict custody discriminator for portable selections', () => {
    const selection = {
      target: {
        pluginId: admittedSnapshot.target.pluginId,
        sourceCustody: { kind: 'development', registeredRootId: 'target-root' },
      },
      point: admittedSnapshot.points[0].protocols[0].contributions[0].operations[0].point,
      contributor: {
        pluginId: admittedSnapshot.points[0].protocols[0].contributions[0].contributor.pluginId,
        contributionId: admittedSnapshot.points[0].protocols[0].contributions[0].contributor.contributionId,
        sourceCustody: { kind: 'development', registeredRootId: 'provider-root' },
      },
    } as const;

    expect(PluginTargetedContributionSelectionV1Schema.safeParse({
      ...selection,
      target: {
        ...selection.target,
        sourceCustody: { kind: 'unknown', registeredRootId: 'target-root' },
      },
    }).success).toBe(false);
    expect(PluginTargetedContributionSelectionV1Schema.safeParse({
      ...selection,
      contributor: {
        ...selection.contributor,
        sourceCustody: { ...selection.contributor.sourceCustody, unexpected: true },
      },
    }).success).toBe(false);
  });

  it('admits only an exact, target-scoped immutable snapshot', () => {
    expect(PluginUiTargetedContributionsV1Schema.parse(admittedSnapshot)).toEqual(admittedSnapshot);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      target: {
        pluginId: admittedSnapshot.target.pluginId,
        occurrenceId: admittedSnapshot.target.occurrenceId,
      },
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: admittedSnapshot.points.map((point) => ({
        ...point,
        protocols: point.protocols.map((protocol) => ({
          ...protocol,
          contributions: protocol.contributions.map((contribution) => ({
            ...contribution,
            contributor: {
              pluginId: contribution.contributor.pluginId,
              contributionId: contribution.contributor.contributionId,
              occurrenceId: contribution.contributor.occurrenceId,
            },
          })),
        })),
      })),
    }).success).toBe(false);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [{
          ...admittedSnapshot.points[0].protocols[0],
          contributions: [{
            ...admittedSnapshot.points[0].protocols[0].contributions[0],
            operations: [{
              ...admittedSnapshot.points[0].protocols[0].contributions[0].operations[0],
              contributor: {
                ...admittedSnapshot.points[0].protocols[0].contributions[0].operations[0].contributor,
                sourceCustody: {
                  kind: 'development',
                  registeredRootId: 'different-provider-root',
                },
              },
            }],
          }],
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
            surfaces: [{
              ...admittedSnapshot.points[0].protocols[0].contributions[0].surfaces[0],
              contributor: {
                ...admittedSnapshot.points[0].protocols[0].contributions[0].surfaces[0].contributor,
                sourceCustody: {
                  kind: 'development',
                  registeredRootId: 'different-provider-root',
                },
              },
            }],
          }],
        }],
      }],
    }).success).toBe(false);
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
    const protocolsAtLimit = Array.from({ length: PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1 }, (_, index) => ({
      ...admittedSnapshot.points[0].protocols[0],
      protocol: { id: 'connection', version: index + 1 },
      contributions: [],
    }));
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: protocolsAtLimit,
      }],
    }).success).toBe(true);
    expect(PluginUiTargetedContributionsV1Schema.safeParse({
      ...admittedSnapshot,
      points: [{
        ...admittedSnapshot.points[0],
        protocols: [...protocolsAtLimit, {
          ...admittedSnapshot.points[0].protocols[0],
          protocol: { id: 'connection', version: PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1 + 1 },
          contributions: [],
        }],
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
          contributions: Array.from(
            { length: PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1 + 1 },
            () => admittedSnapshot.points[0].protocols[0].contributions[0],
          ),
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
        protocols: Array.from({ length: PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1 + 1 }, (_, index) => ({
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
                occurrenceId: 'provider-occurrence-b',
              },
            }],
          }],
        }],
      }],
    }).success).toBe(true);
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
                occurrenceId: 'provider-occurrence-b',
              },
            }],
          }],
        }],
      }],
    }).success).toBe(true);
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

describe('target-local contribution selection', () => {
  const admitted = PluginUiTargetedContributionsV1Schema.parse(admittedSnapshot);
  const contribution = admitted.points[0]!.protocols[0]!.contributions[0]!;
  const selector = {
    pointId: 'connection',
    protocol: { id: 'connection', version: 1 },
    contributor: { pluginId: 'acme.provider', contributionId: 'github-connection' },
  } as const;

  it('returns the exact admitted contribution, surface and operation objects', () => {
    expect(selectPluginUiTargetedContributionV1(admitted, selector)).toBe(contribution);
    expect(selectPluginUiTargetedContributionSurfaceV1(admitted, { ...selector, role: 'detail' }))
      .toBe(contribution.surfaces[0]);
    expect(selectPluginUiTargetedContributionOperationV1(
      admitted,
      { ...selector, role: 'connectionTest' },
    )).toBe(contribution.operations[0]);
  });

  it('returns undefined for every non-matching identity component', () => {
    const misses = [
      { ...selector, pointId: 'other-point' },
      { ...selector, protocol: { id: 'other-protocol', version: 1 } },
      { ...selector, protocol: { id: 'connection', version: 2 } },
      { ...selector, contributor: { ...selector.contributor, pluginId: 'acme.other' } },
      { ...selector, contributor: { ...selector.contributor, contributionId: 'other' } },
    ] as const;
    for (const miss of misses) {
      expect(selectPluginUiTargetedContributionV1(admitted, miss)).toBeUndefined();
      expect(selectPluginUiTargetedContributionSurfaceV1(admitted, { ...miss, role: 'detail' }))
        .toBeUndefined();
    }
    expect(selectPluginUiTargetedContributionSurfaceV1(admitted, { ...selector, role: 'summary' }))
      .toBeUndefined();
    expect(selectPluginUiTargetedContributionOperationV1(admitted, { ...selector, role: 'other' }))
      .toBeUndefined();
  });

  it('selects the role occurrence independently and fails closed for duplicated candidates', () => {
    const staleSurfaceGeneration = {
      ...admitted,
      points: [{
        ...admitted.points[0]!,
        protocols: [{
          ...admitted.points[0]!.protocols[0]!,
          contributions: [{
            ...contribution,
            surfaces: [{
              ...contribution.surfaces[0]!,
              contributor: {
                ...contribution.surfaces[0]!.contributor,
                occurrenceId: 'provider-occurrence-b',
              },
            }],
          }],
        }],
      }],
    };
    expect(selectPluginUiTargetedContributionSurfaceV1(
      staleSurfaceGeneration,
      { ...selector, role: 'detail' },
    )).toBe(staleSurfaceGeneration.points[0]!.protocols[0]!.contributions[0]!.surfaces[0]);

    const duplicatedPoints = { ...admitted, points: [...admitted.points, ...admitted.points] };
    expect(selectPluginUiTargetedContributionV1(duplicatedPoints, selector)).toBeUndefined();
  });
});
