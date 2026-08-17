import { describe, expect, it } from 'vitest';

import {
  DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema,
  DaemonContributionRegistryProjectionDescribeRequestSchema,
  DaemonContributionRegistryProjectionDescribeResponseSchema,
  DaemonPluginUiComposerSurfaceCatalogEntryV1Schema,
  DaemonPluginUiTargetedSurfaceMountV1Schema,
  DaemonPluginReactNativeCrashFailureV1Schema,
  DaemonPluginReactNativeCrashReportRequestV1Schema,
  DaemonPluginReactNativeCrashReportResponseV1Schema,
  DaemonPluginReactNativeCrashBindingTokenV1Schema,
  isSameDaemonPluginReactNativeCrashBindingV1,
  isSameDaemonPluginReactNativeCrashBindingTokenV1,
  DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema,
  DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema,
  DaemonPluginStructuredMessageActionExecuteRequestSchema,
  DaemonPluginStructuredMessageActionExecuteResponseSchema,
  DaemonPluginComposerReferenceSearchRequestSchema,
  DaemonPluginComposerReferenceSearchResponseSchema,
  DaemonPluginUiResourceReadRequestSchema,
  DaemonPluginUiResourceWatchOpenRequestSchema,
  DaemonPluginSettingsWatchRequestSchema,
  DaemonPluginSettingsWatchResponseSchema,
  DaemonPluginUiArtifactBytesReadRequestSchema,
  DaemonPluginUiArtifactBytesReadResponseSchema,
  PluginProjectedActionV2Schema,
  PluginProjectedSettingsFieldV2Schema,
  PluginProjectionInstalledPackageV2Schema,
  PluginProjectionV2Schema,
  PluginUiResourceBindingCapabilityV1Schema,
  projectPluginSettingsContributionV2,
  readDaemonPluginUiTargetedSurfaceMountV1,
} from './contributionRegistryProjection.js';
import * as protocol from '../index.js';
import { RPC_METHODS } from '../rpc/index.js';
import { PluginSettingsContributionV2Schema } from '../plugins/contributions/settings.js';

describe('daemon contribution registry projection (wire)', () => {
  it('keeps exact daemon Settings watches content-free and revision-scoped', () => {
    const request = {
      serverIdentityId: 'srv_settings',
      machineId: 'machine-settings',
      pluginId: 'acme.settings',
      scope: { kind: 'daemon' },
    } as const;

    expect(DaemonPluginSettingsWatchRequestSchema.parse(request)).toEqual(request);
    expect(DaemonPluginSettingsWatchRequestSchema.parse({
      ...request,
      knownRevision: 'settings-r1',
    })).toMatchObject({ knownRevision: 'settings-r1' });
    expect(DaemonPluginSettingsWatchRequestSchema.safeParse({
      ...request,
      scope: { kind: 'account' },
    }).success).toBe(false);
    expect(DaemonPluginSettingsWatchRequestSchema.safeParse({
      ...request,
      values: { endpoint: 'must-not-cross-the-watch' },
    }).success).toBe(false);

    expect(DaemonPluginSettingsWatchResponseSchema.parse({
      status: 'ready',
      revision: 'settings-r1',
    })).toEqual({ status: 'ready', revision: 'settings-r1' });
    expect(DaemonPluginSettingsWatchResponseSchema.parse({
      status: 'changed',
      revision: 'settings-r2',
    })).toEqual({ status: 'changed', revision: 'settings-r2' });
    expect(DaemonPluginSettingsWatchResponseSchema.parse({
      status: 'idle',
      revision: 'settings-r2',
    })).toEqual({ status: 'idle', revision: 'settings-r2' });
    expect(DaemonPluginSettingsWatchResponseSchema.safeParse({
      status: 'changed',
      revision: 'settings-r2',
      values: { endpoint: 'must-not-cross-the-watch' },
    }).success).toBe(false);
  });

  it('keeps daemon-selected composer renderer facts generation-bound without accepting UI-selected candidates', () => {
    const entry = {
      contribution: { pluginId: 'acme.review', localId: 'review' },
      immutableGenerationId: 'review-generation',
      projectionGeneration: 7,
      role: 'attachmentPreview',
      rendererChain: [{ pluginId: 'acme.review', localId: 'review-preview' }],
      selectedRenderer: {
        identity: { pluginId: 'acme.review', localId: 'review-preview' },
        renderer: {
          kind: 'declarative',
          contributionId: 'review-preview',
          model: { visible: true },
        },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
      },
      executionOrigin: {
        serverIdentityId: 'srv_composer',
        materializationRef: {
          machineId: 'machine-composer',
          materializationId: 'review-materialization',
          pluginId: 'acme.review',
        },
      },
      resourceCapability: { readable: true, dynamic: true },
      contributorTargetedContributions: {
        target: { pluginId: 'acme.review', immutableGenerationId: 'review-generation' },
        points: [],
      },
    } as const;

    expect(DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse(entry)).toEqual(entry);
    const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: { v: 1, agentsById: {}, backendsById: {} },
      composerSurfaceCatalog: [entry],
    });
    expect(response.composerSurfaceCatalog).toEqual([entry]);
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      protocolVersion: 1,
      projection: { v: 1, agentsById: {}, backendsById: {} },
      composerSurfaceCatalog: [{ ...entry, role: 'not-a-composer-role' }],
    }).success).toBe(false);
    expect(DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.safeParse({
      ...entry,
      selectedRenderer: {
        ...entry.selectedRenderer,
        identity: { pluginId: 'acme.other', localId: 'review-preview' },
      },
    }).success).toBe(false);
    expect(DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.safeParse({
      ...entry,
      contributorTargetedContributions: {
        ...entry.contributorTargetedContributions,
        target: { pluginId: 'acme.review', immutableGenerationId: 'stale-generation' },
      },
    }).success).toBe(false);
  });

  it('admits a crash token only when its targeted surface mount carries exact current target and contributor identities', () => {
    const token = {
      mount: {
        kind: 'targetedSurface',
        target: { pluginId: 'acme.target', immutableGenerationId: 'target-generation' },
        point: { pointId: 'providers', protocol: { id: 'provider', version: 1 } },
        contributor: {
          pluginId: 'acme.contributor',
          contributionId: 'provider-detail',
          immutableGenerationId: 'contributor-generation',
        },
        role: 'detail',
        presentation: 'content',
      },
      renderer: { pluginId: 'acme.contributor', localId: 'native-detail' },
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      crashStateEpoch: 0,
    } as const;

    expect(DaemonPluginReactNativeCrashBindingTokenV1Schema.parse(token)).toEqual(token);
    expect(DaemonPluginReactNativeCrashBindingTokenV1Schema.safeParse({
      ...token,
      mount: {
        ...token.mount,
        target: { pluginId: token.mount.target.pluginId },
      },
    }).success).toBe(false);

    const composerToken = {
      mount: {
        kind: 'composer',
        contribution: { pluginId: 'acme.composer', localId: 'review' },
        immutableGenerationId: 'composer-generation',
        role: 'attachmentPreview',
      },
      renderer: { pluginId: 'acme.composer', localId: 'review-native-preview' },
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      crashStateEpoch: 0,
    } as const;
    expect(DaemonPluginReactNativeCrashBindingTokenV1Schema.parse(composerToken)).toEqual(composerToken);
    expect(DaemonPluginReactNativeCrashBindingTokenV1Schema.safeParse({
      ...composerToken,
      mount: { ...composerToken.mount, role: 'not-a-composer-role' },
    }).success).toBe(false);
    expect(DaemonPluginReactNativeCrashBindingTokenV1Schema.safeParse({
      ...composerToken,
      mount: { ...composerToken.mount, projectionGeneration: 1 },
    }).success).toBe(false);

    const destinationToken = {
      mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.destination', localId: 'summary' },
      },
      renderer: { pluginId: 'acme.destination', localId: 'native-summary' },
      artifactDigest: `sha256:${'c'.repeat(64)}`,
      crashStateEpoch: 4,
    } as const;

    expect(isSameDaemonPluginReactNativeCrashBindingTokenV1(token, { ...token })).toBe(true);
    expect(isSameDaemonPluginReactNativeCrashBindingTokenV1(destinationToken, { ...destinationToken })).toBe(true);
    expect(isSameDaemonPluginReactNativeCrashBindingTokenV1(composerToken, { ...composerToken })).toBe(true);
    expect(isSameDaemonPluginReactNativeCrashBindingTokenV1(composerToken, {
      ...composerToken,
      mount: {
        ...composerToken.mount,
        contribution: { ...composerToken.mount.contribution, pluginId: 'acme.replaced' },
      },
    })).toBe(false);
    expect(isSameDaemonPluginReactNativeCrashBindingTokenV1(composerToken, {
      ...composerToken,
      mount: {
        ...composerToken.mount,
        contribution: { ...composerToken.mount.contribution, localId: 'replaced-review' },
      },
    })).toBe(false);
    expect(isSameDaemonPluginReactNativeCrashBindingTokenV1(composerToken, {
      ...composerToken,
      mount: { ...composerToken.mount, immutableGenerationId: 'replaced-generation' },
    })).toBe(false);
    expect(isSameDaemonPluginReactNativeCrashBindingTokenV1(composerToken, {
      ...composerToken,
      mount: { ...composerToken.mount, role: 'region' },
    })).toBe(false);
    expect(isSameDaemonPluginReactNativeCrashBindingTokenV1(composerToken, {
      ...composerToken,
      renderer: { ...composerToken.renderer, localId: 'replaced-native-preview' },
    })).toBe(false);
    expect(isSameDaemonPluginReactNativeCrashBindingTokenV1(composerToken, {
      ...composerToken,
      crashStateEpoch: 1,
    })).toBe(false);
    expect(isSameDaemonPluginReactNativeCrashBindingV1(composerToken, {
      ...composerToken,
      artifactDigest: `sha256:${'d'.repeat(64)}`,
      crashStateEpoch: 1,
    })).toBe(true);
    expect(isSameDaemonPluginReactNativeCrashBindingV1(composerToken, {
      ...composerToken,
      mount: { ...composerToken.mount, role: 'region' },
    })).toBe(false);
  });

  it('keeps target-private Surface execution, selected renderer, and child projection correlated to one contributor generation', () => {
    const mount = {
      kind: 'targetedSurface',
      target: { pluginId: 'acme.target', immutableGenerationId: 'target-generation' },
      point: { pointId: 'providers', protocol: { id: 'provider', version: 1 } },
      contributor: {
        pluginId: 'acme.contributor',
        contributionId: 'provider-detail',
        immutableGenerationId: 'contributor-generation',
      },
      role: 'detail',
      presentation: 'content',
      inputSchema: { type: 'object' },
      rendererChain: [{ pluginId: 'acme.contributor', localId: 'detail-renderer' }],
      selectedRenderer: {
        identity: { pluginId: 'acme.contributor', localId: 'detail-renderer' },
        renderer: {
          kind: 'declarative',
          contributionId: 'detail-renderer',
          model: { visible: true },
        },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
      },
      executionOrigin: {
        serverIdentityId: 'srv_targeted',
        materializationRef: {
          machineId: 'machine-targeted',
          materializationId: 'contributor-materialization',
          pluginId: 'acme.contributor',
        },
      },
      resourceCapability: { readable: true, dynamic: true },
      contributorTargetedContributions: {
        target: {
          pluginId: 'acme.contributor',
          immutableGenerationId: 'contributor-generation',
        },
        points: [],
      },
    } as const;

    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.parse(mount)).toEqual(mount);
    const surface = {
      point: mount.point,
      contributor: mount.contributor,
      role: mount.role,
      presentation: mount.presentation,
    } as const;
    expect(readDaemonPluginUiTargetedSurfaceMountV1({
      mounts: [mount],
      target: mount.target,
      surface,
    })).toBe(mount);
    expect(readDaemonPluginUiTargetedSurfaceMountV1({
      mounts: [mount],
      target: { ...mount.target, immutableGenerationId: 'stale-target' },
      surface,
    })).toBeNull();
    expect(readDaemonPluginUiTargetedSurfaceMountV1({
      mounts: [mount, mount],
      target: mount.target,
      surface,
    })).toBeNull();
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      methodCeiling: ['context'],
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      contributorTargetedContributions: {
        ...mount.contributorTargetedContributions,
        target: {
          ...mount.contributorTargetedContributions.target,
          immutableGenerationId: 'other-generation',
        },
      },
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      selectedRenderer: {
        ...mount.selectedRenderer,
        identity: { pluginId: 'acme.other', localId: 'detail-renderer' },
      },
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      rendererChain: [
        ...mount.rendererChain,
        { pluginId: 'acme.other', localId: 'other-renderer' },
      ],
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      selectedRenderer: {
        identity: { pluginId: 'acme.contributor', localId: 'detail-renderer' },
        renderer: { kind: 'reactNative', contributionId: 'detail-renderer' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        artifactProjection: {
          id: 'reactNativeBundle:acme.other:detail-renderer',
          pluginId: 'acme.other',
          contributionKind: 'reactNativeBundle',
          contributionId: 'detail-renderer',
        },
      },
    }).success).toBe(false);
  });

  it('carries only an exact host-stamped Resource context on contextual reads and watches', () => {
    const read = {
      machineId: 'm1',
      expectedGeneration: 'g1',
      callerPluginId: 'acme.activity',
      resource: { pluginId: 'acme.activity', localId: 'progress' },
      context: { kind: 'session', sessionId: 'session-a' },
    } as const;
    expect(DaemonPluginUiResourceReadRequestSchema.parse(read).context).toEqual(read.context);

    expect(DaemonPluginUiResourceReadRequestSchema.safeParse({
      ...read,
      context: { kind: 'session', sessionId: 'session-a', forged: true },
    }).success).toBe(false);

    expect(DaemonPluginUiResourceWatchOpenRequestSchema.parse({
      ...read,
      subscriptionId: 'sub-1',
    }).context).toEqual(read.context);

    const surface = {
      ...read,
      context: {
        kind: 'surface',
        mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
        launchInput: { revision: 2 },
      },
    } as const;
    expect(DaemonPluginUiResourceReadRequestSchema.parse(surface).context).toEqual(surface.context);
    expect(DaemonPluginUiResourceWatchOpenRequestSchema.parse({
      ...surface,
      subscriptionId: 'sub-2',
    }).context).toEqual(surface.context);
    expect(DaemonPluginUiResourceReadRequestSchema.safeParse({
      ...surface,
      context: { ...surface.context, callerContext: { forged: true } },
    }).success).toBe(false);
  });

  it('carries an exact paired execution origin on each projected plugin UI entry', () => {
    const entry = {
      id: 'surfacePlacement:acme.preview:overview',
      pluginId: 'acme.preview',
      contributionKind: 'surfacePlacement',
      serverIdentityId: 'srv_projection_fixture',
      materializationRef: {
        machineId: 'machine_projection_fixture',
        materializationId: 'materialization-current',
        pluginId: 'acme.preview',
      },
    } as const;
    const projection = {
      v: 2,
      generation: 7,
      familiesById: {
        pluginUi: {
          family: 'pluginUi',
          entriesById: {
            [entry.id]: entry,
          },
        },
      },
    } as const;

    expect(PluginProjectionV2Schema.parse(projection).familiesById.pluginUi?.entriesById[entry.id])
      .toMatchObject(entry);

    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            [entry.id]: { ...entry, materializationRef: undefined },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            [entry.id]: {
              ...entry,
              materializationRef: { ...entry.materializationRef, pluginId: 'acme.other' },
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('projects static Composer declarations only with their exact qualified identity and immutable generation', () => {
    const attachment = {
      id: 'acme.composer/issue',
      pluginId: 'acme.composer',
      identity: { pluginId: 'acme.composer', localId: 'issue' },
      immutableGenerationId: 'immutable-composer-7',
      definition: {
        id: 'issue',
        title: 'Issue',
        icon: 'warning',
        cardinality: 'many',
        valueSchema: { type: 'object' },
      },
    } as const;
    const projection = {
      v: 2,
      generation: 7,
      familiesById: {
        composerAttachments: {
          family: 'composerAttachments',
          entriesById: { [attachment.id]: attachment },
        },
      },
    } as const;

    expect(PluginProjectionV2Schema.parse(projection).familiesById.composerAttachments?.entriesById[attachment.id])
      .toMatchObject(attachment);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        composerAttachments: {
          ...projection.familiesById.composerAttachments,
          entriesById: {
            [attachment.id]: {
              ...attachment,
              identity: { pluginId: attachment.pluginId, localId: 'other' },
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('accepts a normalized openable-content viewer only when it targets its own projected details view', () => {
    const entry = {
      id: 'openableContentViewer:acme.viewer:markdown',
      pluginId: 'acme.viewer',
      contributionKind: 'openableContentViewer',
      descriptorId: 'markdown',
      identity: { pluginId: 'acme.viewer', localId: 'markdown' },
      viewer: {
        contentClasses: ['text'],
        mimeTypes: ['text/markdown'],
        extensions: ['.md'],
      },
      destination: { pluginId: 'acme.viewer', localId: 'file-details' },
    } as const;
    const projection = {
      v: 2,
      generation: 7,
      familiesById: {
        pluginUi: {
          family: 'pluginUi',
          entriesById: { [entry.id]: entry },
        },
      },
    } as const;

    expect(PluginProjectionV2Schema.parse(projection).familiesById.pluginUi?.entriesById[entry.id])
      .toMatchObject(entry);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            [entry.id]: {
              ...entry,
              destination: { pluginId: 'acme.other', localId: 'file-details' },
            },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            [entry.id]: {
              ...entry,
              assetPath: '/Users/alice/private.md',
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('bounds a selected surface Resource capability to its two admission facts', () => {
    const capability = Object.freeze({ readable: true, dynamic: false });

    expect(PluginUiResourceBindingCapabilityV1Schema.parse(capability)).toEqual(capability);
    expect(PluginUiResourceBindingCapabilityV1Schema.safeParse({
      readable: true,
      dynamic: false,
      resourceIds: ['secret-resource-id'],
    }).success).toBe(false);
    expect(PluginUiResourceBindingCapabilityV1Schema.safeParse({
      readable: true,
    }).success).toBe(false);
    expect(protocol.PluginUiResourceBindingCapabilityV1Schema.parse(capability)).toEqual(capability);
  });

  it('preserves exact non-safe action confirmation presentation and fails closed on invalid combinations', () => {
    const confirmation = {
      title: { key: 'actions.delete.title', fallback: 'Delete workspace?' },
      body: { key: 'actions.delete.body', fallback: 'This cannot be undone.' },
      confirmLabel: { key: 'actions.delete.confirm', fallback: 'Delete' },
    } as const;
    const projectedAction = {
      id: 'delete-workspace',
      pluginId: 'acme.workspace',
      title: 'Delete workspace',
      scopes: ['workspace'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'destructive',
      confirmation,
    } as const;

    expect(PluginProjectedActionV2Schema.parse(projectedAction)).toMatchObject({
      dangerLevel: 'destructive',
      confirmation,
    });
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      dangerLevel: 'safe',
    }).success).toBe(false);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      confirmation: undefined,
    }).success).toBe(false);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      confirmation: { ...confirmation, input: { secret: 'must-not-project' } },
    }).success).toBe(false);
  });

  it('projects a plugin-only Action without inventing human presentation fields', () => {
    const pluginOnly = {
      id: 'refresh-provider-state',
      pluginId: 'acme.provider',
      title: 'Refresh provider state',
      scopes: ['session'],
      surfaces: ['plugin'],
      dangerLevel: 'writesRemote',
    } as const;

    expect(PluginProjectedActionV2Schema.parse(pluginOnly)).toEqual(pluginOnly);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...pluginOnly,
      surfaces: ['ui'],
    }).success).toBe(false);
  });

  it('requires an explicit plugin action invocation surface on the wire', () => {
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.voice/mint-session',
      input: null,
      executionSurface: 'ui',
    }).executionSurface).toBe('ui');

    // UI-D26: the surface is the target-action authorization input, so an
    // omitted field must be a wire rejection rather than a host-side default.
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.voice/mint-session',
      input: null,
    }).success).toBe(false);
  });

  it('preserves an omitted action input distinctly from an explicit JSON null', () => {
    const base = {
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.voice/mint-session',
      executionSurface: 'ui' as const,
    };

    const omitted = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(base);
    expect(Object.prototype.hasOwnProperty.call(omitted, 'input')).toBe(false);

    const explicitNull = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      ...base,
      input: null,
    });
    expect(Object.prototype.hasOwnProperty.call(explicitNull, 'input')).toBe(true);
    expect(explicitNull.input).toBeNull();
  });

  it('admits one exact selected-action settlement carrier without placing its Account ref in outer Action input', () => {
    const base = {
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.channels/prepare-connection',
      input: {
        credentialRef: {
          service: { pluginId: 'acme.github', localId: 'github' },
          accountId: 'account-b',
        },
        providerSetupInput: { repository: 'happier-dev/happier' },
      },
      executionSurface: 'ui' as const,
      invocation: {
        kind: 'mountedPluginSurface' as const,
        mountedBinding: {
          contributionLocalId: 'channels-connection',
          materializationRef: {
            machineId: 'm1',
            materializationId: 'channels-current',
            pluginId: 'acme.channels',
          },
        },
      },
    };
    const selectedActionInputCarrier = {
      operation: {
        point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
        contributor: {
          pluginId: 'acme.github',
          contributionId: 'github-connection',
          immutableGenerationId: 'generation-b',
        },
        role: 'setup' as const,
        action: { pluginId: 'acme.github', localId: 'setup-connection' },
      },
      result: {
        kind: 'submitted' as const,
        action: { pluginId: 'acme.github', localId: 'setup-connection' },
        input: { repository: 'happier-dev/happier' },
        selection: {
          target: { pluginId: 'acme.channels', immutableGenerationId: 'channels-generation' },
          point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
          contributor: {
            pluginId: 'acme.github',
            contributionId: 'github-connection',
            immutableGenerationId: 'generation-b',
          },
        },
        connectedAccount: {
          kind: 'selected' as const,
          fieldPath: 'credentialRef',
          ref: {
            service: { pluginId: 'acme.github', localId: 'github' },
            accountId: 'account-b',
          },
        },
      },
    };

    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      ...base,
      selectedActionInputCarrier,
    }).selectedActionInputCarrier).toEqual(selectedActionInputCarrier);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...base,
      selectedActionInputCarrier: {
        ...selectedActionInputCarrier,
        result: {
          ...selectedActionInputCarrier.result,
          action: { pluginId: 'acme.github', localId: 'different-action' },
        },
      },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...base,
      selectedActionInputCarrier,
      invocation: undefined,
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...base,
      selectedActionInputCarrier,
      executionSurface: 'cli',
    }).success).toBe(false);
  });

  it('uses only the host-derived target Action and field identity to resolve Connected Account options', () => {
    const request = DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema.parse({
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.accounts/select-account',
      fieldPath: 'credentialRef',
    });
    expect(request).toEqual({
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.accounts/select-account',
      fieldPath: 'credentialRef',
    });
    expect(DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema.safeParse({
      ...request,
      purpose: 'forged-purpose',
    }).success).toBe(false);
    expect(DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema.safeParse({
      ...request,
      service: { pluginId: 'acme.accounts', localId: 'service' },
    }).success).toBe(false);

    expect(DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
      ok: true,
      options: [{
        value: {
          service: { pluginId: 'acme.accounts', localId: 'service' },
          accountId: 'account-1',
        },
        label: 'Work account',
      }],
    })).toEqual({
      ok: true,
      options: [{
        value: {
          service: { pluginId: 'acme.accounts', localId: 'service' },
          accountId: 'account-1',
        },
        label: 'Work account',
      }],
    });
    expect(DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.safeParse({
      ok: true,
      options: [{
        value: {
          service: { pluginId: 'acme.accounts', localId: 'service' },
          accountId: 'account-1',
        },
        label: 'Work account',
        credential: 'must-not-leak',
      }],
    }).success).toBe(false);
  });

  it('carries a mounted binding only in the daemon-validated mounted invocation arm', () => {
    const request = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.target/publish',
      input: { title: 'Ready' },
      executionSurface: 'ui',
      expectedContributorImmutableGenerationId: 'contributor-generation-a',
      invocation: {
        kind: 'mountedPluginSurface',
        mountedBinding: {
          contributionLocalId: 'dashboard',
          materializationRef: {
            machineId: 'm1',
            materializationId: 'materialization-current',
            pluginId: 'acme.mounted',
          },
        },
      },
    });

    expect(request).toMatchObject({
      executionSurface: 'ui',
      expectedContributorImmutableGenerationId: 'contributor-generation-a',
      invocation: {
        kind: 'mountedPluginSurface',
        mountedBinding: {
          contributionLocalId: 'dashboard',
          materializationRef: {
            machineId: 'm1',
            materializationId: 'materialization-current',
            pluginId: 'acme.mounted',
          },
        },
      },
    });
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      invocation: {
        ...request.invocation,
        mountedBinding: {
          ...request.invocation.mountedBinding,
          contributionLocalId: 'not valid',
        },
      },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      mountedBinding: request.invocation.mountedBinding,
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      caller: {
        kind: 'plugin',
        pluginId: 'acme.forged',
        contributionLocalId: 'dashboard',
      },
    }).success).toBe(false);
  });

  it('requires a bounded host-stamped current intent for host-presented Composer and Message Actions', () => {
    const composerRequest = {
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.target/publish',
      executionSurface: 'ui' as const,
      sessionId: 'session-current',
      invocation: {
        kind: 'hostPresentedComposer' as const,
        currentComposerIntent: {
          composer: { kind: 'session' as const, sessionId: 'session-current' },
          revision: 4,
        },
      },
    };

    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(composerRequest))
      .toMatchObject(composerRequest);
    // A missing host witness, a stale session witness, and a mounted caller in
    // the host-presented arm must all fail before the daemon sees an Action.
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...composerRequest,
      invocation: { kind: 'hostPresentedComposer' },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...composerRequest,
      sessionId: 'session-replaced',
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...composerRequest,
      invocation: {
        ...composerRequest.invocation,
        mountedBinding: {
          contributionLocalId: 'forged',
          materializationRef: {
            machineId: 'm1',
            materializationId: 'current',
            pluginId: 'acme.forged',
          },
        },
      },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...composerRequest,
      caller: { kind: 'plugin', pluginId: 'acme.forged' },
    }).success).toBe(false);

    const messageReference = {
      v: 1 as const,
      sessionId: 'session-current',
      messageId: 'message-current',
      observedRevision: 'revision-current',
    };
    const messageRequest = {
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.target/publish',
      executionSurface: 'ui' as const,
      sessionId: 'session-current',
      messageActionReference: messageReference,
      invocation: {
        kind: 'hostPresentedMessage' as const,
        currentMessageIntent: messageReference,
      },
    };
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(messageRequest))
      .toMatchObject(messageRequest);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...messageRequest,
      invocation: {
        ...messageRequest.invocation,
        currentMessageIntent: {
          ...messageReference,
          observedRevision: 'revision-stale',
        },
      },
    }).success).toBe(false);
  });

  it('carries only an opaque Message Action reference through the existing structured-action transport', () => {
    const request = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.voice/mint-session',
      input: null,
      executionSurface: 'ui',
      messageActionReference: {
        v: 1,
        sessionId: 'session-durable',
        messageId: 'message-durable',
        observedRevision: 'message-updated-at:7',
      },
    });

    expect(request.messageActionReference).toEqual({
      v: 1,
      sessionId: 'session-durable',
      messageId: 'message-durable',
      observedRevision: 'message-updated-at:7',
    });
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      messageActionReference: { ...request.messageActionReference, localId: 'ui-local-id' },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      messageActionReference: { ...request.messageActionReference, message: { text: 'caller payload' } },
    }).success).toBe(false);
  });

  it('carries one exact bounded composer-reference search without a retired provider envelope', () => {
    const request = DaemonPluginComposerReferenceSearchRequestSchema.parse({
      machineId: 'm1',
      expectedGeneration: '7',
      reference: { pluginId: 'acme.issues', localId: 'issues' },
      trigger: '$',
      query: 'e\u0301',
    });
    expect(request.query).toBe('é');
    expect(request.trigger).toBe('$');

    // Supported older UI builds did not carry trigger identity. The Protocol
    // seam expands that legacy shape to the only trigger they could emit.
    expect(DaemonPluginComposerReferenceSearchRequestSchema.parse({
      machineId: 'm1',
      expectedGeneration: '7',
      reference: { pluginId: 'acme.issues', localId: 'issues' },
      query: 'issue',
    }).trigger).toBe('@');

    expect(DaemonPluginComposerReferenceSearchRequestSchema.safeParse({
      ...request,
      query: 'x'.repeat(257),
    }).success).toBe(false);
    expect(DaemonPluginComposerReferenceSearchRequestSchema.safeParse({
      ...request,
      candidateId: 'must-not-be-on-search',
    }).success).toBe(false);
    expect(DaemonPluginComposerReferenceSearchRequestSchema.safeParse({
      ...request,
      provider: request.reference,
    }).success).toBe(false);

    expect(DaemonPluginComposerReferenceSearchResponseSchema.parse({
      ok: true,
      reference: request.reference,
      page: [{ id: 'issue:42', label: 'Issue 42', description: 'Open incident' }],
    })).toMatchObject({ ok: true, reference: request.reference });
    expect(DaemonPluginComposerReferenceSearchResponseSchema.safeParse({
      ok: true,
      reference: request.reference,
      page: [{ id: 'issue:42', label: 'Issue 42', context: 'must-not-reach-the-picker' }],
    }).success).toBe(false);
  });

  it('carries one generation-bound attachment preparation callback request without a terminal Message identity', async () => {
    type Schema = Readonly<{
      parse(value: unknown): unknown;
      safeParse(value: unknown): Readonly<{ success: boolean }>;
    }>;
    const module = await import('./contributionRegistryProjection.js');
    const requestSchema = Reflect.get(
      module,
      'DaemonPluginComposerAttachmentPrepareRequestSchema',
    ) as Schema | undefined;
    const responseSchema = Reflect.get(
      module,
      'DaemonPluginComposerAttachmentPrepareResponseSchema',
    ) as Schema | undefined;

    expect(requestSchema).toBeDefined();
    expect(responseSchema).toBeDefined();
    if (!requestSchema || !responseSchema) return;

    const request = {
      machineId: 'machine-1',
      expectedGeneration: '7',
      attachment: { pluginId: 'acme.issues', localId: 'issue' },
      request: {
        sessionId: 'session-1',
        localId: 'local-1',
        attachments: [{
          instanceId: 'attachment-1',
          key: 'issue:42',
          value: { issueId: '42' },
        }],
      },
    } as const;
    expect(requestSchema.parse(request)).toEqual(request);
    expect(requestSchema.safeParse({
      ...request,
      request: { ...request.request, messageId: 'terminal-message-1' },
    }).success).toBe(false);
    expect(requestSchema.safeParse({
      ...request,
      request: { ...request.request, messageLocalId: 'legacy-local-1' },
    }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, preparedAttachments: [] }).success).toBe(false);

    const response = {
      ok: true,
      attachment: request.attachment,
      result: {
        attachments: [{
          instanceId: 'attachment-1',
          status: 'ready',
          value: { issueId: '42', prepared: true },
        }],
      },
    } as const;
    expect(responseSchema.parse(response)).toEqual(response);
    expect(responseSchema.safeParse({ ...response, messageId: 'terminal-message-1' }).success).toBe(false);
    expect(responseSchema.safeParse({
      ok: false,
      code: 'composer_attachment_unavailable',
      reason: 'unavailable',
    }).success).toBe(true);
    expect((RPC_METHODS as Readonly<Record<string, string>>).DAEMON_PLUGIN_COMPOSER_ATTACHMENT_PREPARE)
      .toBe('daemon.plugins.composerAttachments.prepare');
  });

  it('rejects non-JSON structured-message action results at the wire boundary', () => {
    expect(DaemonPluginStructuredMessageActionExecuteResponseSchema.safeParse({
      ok: true,
      result: () => undefined,
    }).success).toBe(false);
  });

  it('parses a minimal v1 describe request/response payload', () => {
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({ machineId: 'm1' })).toEqual({
      machineId: 'm1',
    });

    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        v: 1,
        agentsById: {
          custom: { id: 'custom', title: 'Custom', channel: 'plugin' },
        },
        backendsById: {
          b1: { id: 'b1', agentId: 'custom' },
        },
      },
    });
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.projection.v).toBe(1);
    expect(parsed.projection.agentsById.custom?.id).toBe('custom');
    expect(parsed.projection.backendsById.b1?.agentId).toBe('custom');
  });

  it('accepts one strict mounted target request and only a matching typed sibling snapshot', () => {
    const mountedTarget = {
      pluginId: 'acme.target',
      immutableGenerationId: 'target-generation-a',
    } as const;
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      mountedTarget,
    }).mountedTarget).toEqual(mountedTarget);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      mountedTarget: { ...mountedTarget, unexpected: true },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      mountedTarget: { pluginId: 'acme.target', immutableGenerationId: '' },
    }).success).toBe(false);

    const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: { v: 1, agentsById: {}, backendsById: {} },
      targetedContributions: { target: mountedTarget, points: [] },
    });
    expect(response.targetedContributions).toEqual({ target: mountedTarget, points: [] });
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      protocolVersion: 1,
      projection: { v: 1, agentsById: {}, backendsById: {} },
      targetedContributions: {
        target: mountedTarget,
        points: [{ pointId: 'providers', protocols: [] }],
      },
    }).success).toBe(false);
  });

  it('carries current Event Automation composer siblings without changing PluginProjectionV2', () => {
    const automationEligibleEvents = [{
      event: {
        id: 'acme.events/repository/updated',
        identity: { pluginId: 'acme.events', localId: 'repository/updated' },
        immutableGenerationId: 'event-generation-a',
        title: 'Repository updated',
        description: null,
        payloadSchema: { type: 'object', additionalProperties: false },
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'],
            sourceConfigSchema: { type: 'object', additionalProperties: false },
            setupActionRef: { pluginId: 'acme.events', localId: 'configure-source' },
            historyGapResetActionRef: { pluginId: 'acme.events', localId: 'baseline-history-gap' },
          },
        },
      },
      setupAction: {
        id: 'acme.events/configure-source',
        identity: { pluginId: 'acme.events', localId: 'configure-source' },
        immutableGenerationId: 'event-generation-a',
        title: 'Configure source',
        description: 'Choose a repository',
        inputSchema: { type: 'object', additionalProperties: false },
        inputHints: null,
      },
      historyGapResetAction: {
        id: 'acme.events/baseline-history-gap',
        identity: { pluginId: 'acme.events', localId: 'baseline-history-gap' },
        immutableGenerationId: 'event-generation-a',
        title: 'Resume source',
        description: 'Baseline the current source head',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { automationId: { type: 'string' } },
          required: ['automationId'],
        },
        inputHints: null,
      },
    }] as const;

    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: { v: 1, agentsById: {}, backendsById: {} },
      automationEligibleEvents,
    });

    expect(parsed.automationEligibleEvents).toEqual(automationEligibleEvents);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      installedPackagesById: {},
      agentsById: {},
      backendsById: {},
      actionsById: {},
      toolsById: {},
      commandsById: {},
      resourcesById: {},
      settingsById: {},
      familiesById: {},
      diagnostics: [],
      automationEligibleEvents,
    }).success).toBe(false);
  });

  it('does not inherit the retired manifest array-entry ceiling for Automation siblings', () => {
    const eligibleEvent = {
      event: {
        id: 'acme.events/repository/updated',
        identity: { pluginId: 'acme.events', localId: 'repository/updated' },
        immutableGenerationId: 'event-generation-a',
        title: 'Repository updated',
        description: null,
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'],
            sourceConfigSchema: { type: 'object', additionalProperties: false },
            setupActionRef: { pluginId: 'acme.events', localId: 'configure-source' },
          },
        },
      },
      setupAction: {
        id: 'acme.events/configure-source',
        identity: { pluginId: 'acme.events', localId: 'configure-source' },
        immutableGenerationId: 'event-generation-a',
        title: 'Configure source',
        description: null,
        inputSchema: { type: 'object', additionalProperties: false },
        inputHints: null,
      },
    } as const;

    expect(DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema.safeParse(
      Array.from({ length: 8_193 }, () => eligibleEvent),
    ).success).toBe(true);
  });

  it('accepts a deployed legacy managed-dependency title while current writers omit it', () => {
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      familiesById: {
        managedDependencies: {
          family: 'managedDependencies',
          entriesById: {
            'acme.runtime/runtime': {
              id: 'runtime',
              pluginId: 'acme.runtime',
              title: 'Runtime',
              executable: 'runtime',
            },
          },
        },
      },
    }).success).toBe(true);
  });

  it('accepts canonical Agent projections and rejects retired Provider aliases', () => {
    const canonicalV1 = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        v: 1,
        agentsById: {
          custom: {
            id: 'custom',
            title: 'Custom',
            catalogAgentId: 'claude',
          },
        },
        backendsById: {
          b1: {
            id: 'b1',
            agentId: 'custom',
            catalogAgentId: 'claude',
          },
        },
      },
    });
    expect(canonicalV1.projection).toMatchObject({
      v: 1,
      agentsById: {
        custom: { id: 'custom', catalogAgentId: 'claude' },
      },
      backendsById: {
        b1: { agentId: 'custom', catalogAgentId: 'claude' },
      },
    });
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      protocolVersion: 1,
      projection: { v: 1, providerId: 'future-v1-metadata' },
    }).success).toBe(true);

    const canonicalV2 = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 1,
      agentsById: {
        custom: {
          id: 'custom',
          title: 'Custom',
          catalogAgentId: 'claude',
        },
      },
      backendsById: {
        b1: {
          id: 'b1',
          agentId: 'custom',
          catalogAgentId: 'claude',
        },
      },
    });
    expect(canonicalV2).toMatchObject({
      agentsById: {
        custom: { id: 'custom', catalogAgentId: 'claude' },
      },
      backendsById: {
        b1: { agentId: 'custom', catalogAgentId: 'claude' },
      },
    });

    const retiredV1Projections = [
      {
        v: 1,
        providersById: { custom: { id: 'custom' } },
      },
      {
        v: 1,
        agentsById: { custom: { id: 'custom', providerId: 'custom' } },
      },
      {
        v: 1,
        agentsById: { custom: { id: 'custom', providerAgentId: 'claude' } },
      },
      {
        v: 1,
        backendsById: { b1: { id: 'b1', agentId: 'custom', providerId: 'custom' } },
      },
      {
        v: 1,
        backendsById: { b1: { id: 'b1', agentId: 'custom', providerAgentId: 'claude' } },
      },
    ];
    for (const projection of retiredV1Projections) {
      expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
        protocolVersion: 1,
        projection,
      }).success).toBe(false);
    }

    const retiredV2Projections = [
      {
        v: 2,
        generation: 1,
        providersById: { custom: { providerId: 'custom' } },
      },
      {
        v: 2,
        generation: 1,
        agentsById: { custom: { id: 'custom', providerId: 'custom' } },
      },
      {
        v: 2,
        generation: 1,
        agentsById: { custom: { id: 'custom', providerAgentId: 'claude' } },
      },
      {
        v: 2,
        generation: 1,
        backendsById: { b1: { id: 'b1', agentId: 'custom', providerId: 'custom' } },
      },
      {
        v: 2,
        generation: 1,
        backendsById: { b1: { id: 'b1', agentId: 'custom', providerAgentId: 'claude' } },
      },
    ];
    for (const projection of retiredV2Projections) {
      expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(false);
    }

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      familiesById: {
        providers: {
          family: 'providers',
          entriesById: {
            'acme.provider/openai': {
              id: 'openai',
              pluginId: 'acme.provider',
              definition: {},
            },
          },
        },
      },
    }).success).toBe(true);
  });

  it('accepts a typed React Native host runtime identity and rejects malformed known fields', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        appVersion: '0.2.1',
        nativeApplicationVersion: '0.2.0',
        nativeBuildVersion: '101',
        applicationId: 'dev.happier.app',
        rawUpdateChannel: 'internalpreview',
        reactVersion: '19.2.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: 'runtime-55',
        hermesVersion: '0.15.0',
        availableNativeCapabilities: ['host.native.camera'],
      },
    });

    expect(parsed.reactNativeHostRuntimeIdentity).toEqual({
      platform: 'ios',
      channel: 'internal',
      appVersion: '0.2.1',
      nativeApplicationVersion: '0.2.0',
      nativeBuildVersion: '101',
      applicationId: 'dev.happier.app',
      rawUpdateChannel: 'internalpreview',
      reactVersion: '19.2.0',
      reactNativeVersion: '0.83.4',
      expoRuntimeVersion: 'runtime-55',
      hermesVersion: '0.15.0',
      availableNativeCapabilities: ['host.native.camera'],
    });

    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'web', channel: 'internal' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'preview' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        availableNativeCapabilities: [123],
      },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        scriptManagerRuntimeIntegrated: true,
      },
    }).success).toBe(false);
  });

  it('carries optional reported ScriptManager readiness on the host runtime identity and stays fail-closed when absent', () => {
    const integrated = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        scriptManagerRuntime: {
          integrated: true,
          installedArtifactLoaderAvailable: true,
        },
      },
    });
    expect(integrated.reactNativeHostRuntimeIdentity?.scriptManagerRuntime).toEqual({
      integrated: true,
      installedArtifactLoaderAvailable: true,
    });

    // Omitting readiness parses (default fail-closed: no reported readiness).
    const absent = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
    });
    expect(absent.reactNativeHostRuntimeIdentity).not.toHaveProperty('scriptManagerRuntime');

    // A partial readiness report (one bit missing) cannot silently flip the gate.
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        scriptManagerRuntime: { integrated: true },
      },
    }).success).toBe(false);

    // Unknown readiness keys are rejected (strict).
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        scriptManagerRuntime: {
          integrated: true,
          installedArtifactLoaderAvailable: true,
          unexpected: true,
        },
      },
    }).success).toBe(false);
  });

  it('accepts only a complete typed React Native web loader capability', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeWebLoaderCapability: {
        integrated: true,
        installedArtifactLoaderAvailable: true,
      },
    });
    expect(parsed.reactNativeWebLoaderCapability).toEqual({
      integrated: true,
      installedArtifactLoaderAvailable: true,
    });

    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeWebLoaderCapability: { integrated: true },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeWebLoaderCapability: {
        integrated: true,
        installedArtifactLoaderAvailable: true,
        unexpected: true,
      },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
      reactNativeWebLoaderCapability: {
        integrated: true,
        installedArtifactLoaderAvailable: true,
      },
    }).success).toBe(false);
  });

  it('normalizes the predecessor browser fact and accepts only exact factual hosted frame adapters', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      hostedWebFrameCapability: {
        platform: 'web',
        adapter: 'domIframe',
      },
    });
    expect(parsed.hostedWebFrameCapability).toEqual({
      platform: 'web',
      adapter: 'domIframe',
    });

    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
      hostedWebFrameCapability: { platform: 'ios', adapter: 'WKWebView' },
    }).hostedWebFrameCapability).toEqual({ platform: 'ios', adapter: 'WKWebView' });
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
      hostedWebFrameCapability: { platform: 'android', adapter: 'WebViewAssetLoader' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'android', adapter: 'WebViewAssetLoader' },
    }).hostedWebFrameCapability).toEqual({ platform: 'android', adapter: 'WebViewAssetLoader' });
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'desktop', adapter: 'wry' },
    }).hostedWebFrameCapability).toEqual({ platform: 'desktop', adapter: 'wry' });

    // `remote-dev` currently sends this predecessor-only browser spelling.
    // Normalize it exactly once at the Protocol ingress rather than making
    // every downstream host-runtime consumer carry two fact shapes.
    const predecessor = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      hostedWebBrowserFrameCapability: { platform: 'web', adapter: 'domIframe' },
    });
    expect(predecessor.hostedWebFrameCapability).toEqual({
      platform: 'web',
      adapter: 'domIframe',
    });
    expect(predecessor).not.toHaveProperty('hostedWebBrowserFrameCapability');

    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'desktop', adapter: 'domIframe' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'web', adapter: 'domIframe', available: true },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'web', adapter: 'sourcePresence' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'ios', adapter: 'WebViewAssetLoader' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'web', adapter: 'domIframe' },
      hostedWebBrowserFrameCapability: { platform: 'web', adapter: 'domIframe' },
    }).success).toBe(false);
  });

  it('parses a v2 describe response payload that carries the authoritative plugin projection', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        v: 2,
        generation: 7,
        installedPackagesById: {
          'acme.plugin': {
            id: 'acme.plugin',
            displayName: 'Acme Plugin',
            version: '1.2.3',
            enabled: true,
            source: {
              kind: 'path',
              locator: '/tmp/acme',
            },
          },
        },
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        diagnostics: [],
      },
    });

    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.projection.v).toBe(2);
    expect(parsed.projection.installedPackagesById['acme.plugin']?.displayName).toBe('Acme Plugin');
  });

  it('normalizes only the active predecessor daemon projection fields at the describe-response ingress', () => {
    const predecessorResponse = {
      protocolVersion: 1 as const,
      projection: {
        v: 2 as const,
        generation: 17,
        agentsById: {
          'acme-agent': {
            id: 'acme-agent',
            externalSessions: {
              agent: { pluginId: 'acme.external-sessions', localId: 'acme-agent' },
              generation: 17,
              operations: {
                listCandidates: true,
                resolveLinkIdentity: true,
                pageTranscript: true,
                readAfterTranscript: true,
              },
              sources: [{
                sourceKind: 'acmeArchive',
                schema: {
                  fields: [{ name: 'kind', kind: 'literal' as const, value: 'acmeArchive' }],
                  passthrough: true,
                },
                key: { segments: [{ kind: 'literal' as const, value: 'acmeArchive' }] },
              }],
            },
          },
        },
        actionsById: {
          'acme.external-sessions.open': {
            id: 'acme.external-sessions.open',
            pluginId: 'acme.external-sessions',
            title: 'Open archive',
            scopes: ['settings' as const],
            surfaces: ['ui' as const],
            placement: 'primary',
            dangerLevel: 'safe' as const,
          },
        },
        familiesById: {
          pluginUi: {
            family: 'pluginUi' as const,
            entriesById: {
              'surfacePlacement:acme.ui:activity': {
                id: 'surfacePlacement:acme.ui:activity',
                pluginId: 'acme.ui',
                contributionKind: 'surfacePlacement',
                descriptorId: 'activity',
                generatedV2: true,
                container: 'appPage',
                target: { kind: 'app' as const },
                binding: {
                  destination: { pluginId: 'acme.ui', localId: 'activity' },
                  rendererChain: [{ pluginId: 'acme.ui', localId: 'activity-renderer' }],
                  renderer: { pluginId: 'acme.ui', localId: 'activity-renderer' },
                  container: 'appPage',
                  target: { kind: 'app' as const },
                  targetKind: 'app',
                  surfaceContextPlacement: 'appSurface',
                  instancePolicy: 'singleton',
                  platforms: ['android', 'desktop', 'ios', 'web'],
                  collisionDomain: { container: 'appPage', targetKind: 'app' },
                  collisionKey: 'appPage\u0000app\u0000acme.ui/activity',
                  methodCeiling: [
                    'context',
                    'watchContext',
                    'executeAction',
                    'readResource',
                    'statOpenableContent',
                    'readOpenableContent',
                    'watchResource',
                    'openSurface',
                    'notify',
                    'confirm',
                    'diagnostic',
                    'readClipboard',
                    'writeClipboard',
                    'openExternalLink',
                  ],
                },
                renderer: { kind: 'declarative' as const },
                display: { titleKey: 'activity', developerFallback: 'Activity' },
                actions: [],
                availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
              },
            },
          },
        },
      },
    };

    // The generic projection remains closed; this predecessor shape is only
    // admitted at the daemon response ingress and immediately normalized.
    expect(PluginProjectionV2Schema.safeParse(predecessorResponse.projection).success).toBe(false);

    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(predecessorResponse);
    expect(parsed.projection.v).toBe(2);
    if (parsed.projection.v !== 2) throw new Error('Expected V2 projection');

    expect(parsed.projection.agentsById['acme-agent']?.externalSessions?.sources[0]?.schema)
      .not.toHaveProperty('passthrough');
    expect(parsed.projection.actionsById['acme.external-sessions.open']).toMatchObject({
      placementBindings: ['primary'],
    });
    expect(parsed.projection.actionsById['acme.external-sessions.open'])
      .not.toHaveProperty('placement');
    expect(parsed.projection.familiesById.pluginUi?.entriesById['surfacePlacement:acme.ui:activity']?.binding)
      .not.toHaveProperty('collisionDomain');
    expect(parsed.projection.familiesById.pluginUi?.entriesById['surfacePlacement:acme.ui:activity']?.binding)
      .not.toHaveProperty('collisionKey');
    expect(parsed.projection.familiesById.pluginUi?.entriesById['surfacePlacement:acme.ui:activity']?.binding)
      .not.toHaveProperty('methodCeiling');

    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      ...predecessorResponse,
      projection: {
        ...predecessorResponse.projection,
        agentsById: {
          'acme-agent': {
            ...predecessorResponse.projection.agentsById['acme-agent'],
            externalSessions: {
              ...predecessorResponse.projection.agentsById['acme-agent'].externalSessions,
              sources: [{
                ...predecessorResponse.projection.agentsById['acme-agent'].externalSessions.sources[0],
                schema: {
                  ...predecessorResponse.projection.agentsById['acme-agent'].externalSessions.sources[0].schema,
                  passthrough: false,
                },
              }],
            },
          },
        },
      },
    }).success).toBe(false);

    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      ...predecessorResponse,
      projection: {
        ...predecessorResponse.projection,
        actionsById: {
          ...predecessorResponse.projection.actionsById,
          'acme.external-sessions.open': {
            ...predecessorResponse.projection.actionsById['acme.external-sessions.open'],
            placement: 'not-a-current-placement',
          },
        },
      },
    }).success).toBe(false);

    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      ...predecessorResponse,
      projection: {
        ...predecessorResponse.projection,
        familiesById: {
          ...predecessorResponse.projection.familiesById,
          pluginUi: {
            ...predecessorResponse.projection.familiesById.pluginUi,
            entriesById: {
              ...predecessorResponse.projection.familiesById.pluginUi.entriesById,
              'surfacePlacement:acme.ui:activity': {
                ...predecessorResponse.projection.familiesById.pluginUi.entriesById['surfacePlacement:acme.ui:activity'],
                binding: {
                  ...predecessorResponse.projection.familiesById.pluginUi.entriesById['surfacePlacement:acme.ui:activity'].binding,
                  collisionKey: 'appPage\u0000app\u0000acme.ui/tampered',
                },
              },
            },
          },
        },
      },
    }).success).toBe(false);

    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      ...predecessorResponse,
      projection: {
        ...predecessorResponse.projection,
        agentsById: {
          'acme-agent': {
            ...predecessorResponse.projection.agentsById['acme-agent'],
            externalSessions: {
              ...predecessorResponse.projection.agentsById['acme-agent'].externalSessions,
              sources: [{
                ...predecessorResponse.projection.agentsById['acme-agent'].externalSessions.sources[0],
                schema: {
                  ...predecessorResponse.projection.agentsById['acme-agent'].externalSessions.sources[0].schema,
                  unexpectedSchemaAuthority: true,
                },
              }],
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('rejects raw manifest digests in installed-package projections', () => {
    expect(PluginProjectionInstalledPackageV2Schema.safeParse({
      id: 'acme.plugin',
      displayName: 'Acme Plugin',
      version: '1.2.3',
      enabled: true,
      source: {
        kind: 'path',
        locator: '/tmp/acme',
      },
      digest: 'sha256:manifest',
    }).success).toBe(false);
  });

  it('carries only a committed immutable generation on installed-package projections', () => {
    const installedPackage = {
      id: 'acme.plugin',
      displayName: 'Acme Plugin',
      version: '1.2.3',
      enabled: true,
      source: {
        kind: 'path',
        locator: '/tmp/acme',
      },
      immutableGenerationId: 'committed-generation-a',
    } as const;

    expect(PluginProjectionInstalledPackageV2Schema.parse(installedPackage)).toMatchObject({
      id: 'acme.plugin',
      immutableGenerationId: 'committed-generation-a',
    });
    expect(PluginProjectionInstalledPackageV2Schema.safeParse({
      ...installedPackage,
      immutableGenerationId: ' ',
    }).success).toBe(false);
  });

  it('parses v2 plugin projection descriptors without executable handler internals', () => {
    expect(typeof PluginProjectionV2Schema?.parse).toBe('function');
    expect((protocol as { PluginProjectedHookV2Schema?: unknown }).PluginProjectedHookV2Schema).toBeUndefined();
    expect((protocol as { ExtensionProjectionV2Schema?: unknown }).ExtensionProjectionV2Schema).toBeUndefined();
    expect((protocol as { ExtensionProjectedHookV2Schema?: unknown }).ExtensionProjectedHookV2Schema).toBeUndefined();

    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      installedPackagesById: {
        'acme.plugin': {
          id: 'acme.plugin',
          displayName: 'Acme Plugin',
          version: '1.2.3',
          enabled: true,
          source: {
            kind: 'path',
            locator: '/tmp/acme',
          },
        },
      },
      actionsById: {
        'acme.plugin.refresh': {
          id: 'acme.plugin.refresh',
          pluginId: 'acme.plugin',
          title: 'Refresh Acme',
          scopes: ['settings'],
          surfaces: ['agent'],
          placementBindings: ['primary'],
          dangerLevel: 'safe',
          available: true,
        },
      },
      toolsById: {
        'acme.plugin.search': {
          id: 'acme.plugin.search',
          pluginId: 'acme.plugin',
          title: 'Search Acme',
          exposesToAgent: true,
        },
      },
      commandsById: {
        'acme.plugin.reload': {
          id: 'acme.plugin.reload',
          pluginId: 'acme.plugin',
          title: 'Reload Acme',
          surfaces: ['agentSlash'],
          tokens: ['acme-reload'],
        },
      },
      resourcesById: {
        'acme.plugin.prompt': {
          id: 'acme.plugin.prompt',
          pluginId: 'acme.plugin',
          resourceKind: 'prompt',
          path: 'resources/prompt.md',
          digest: 'sha256:abc123',
        },
      },
      diagnostics: [
        {
          version: 1,
          id: 'acme.plugin:normalization:plugin:0',
          data: {
            severity: 'warning',
            code: 'plugin.futureCapability',
            message: 'Unsupported future capability',
          },
          plugin: { id: 'acme.plugin', version: '1.2.3', source: 'localPath' },
          stage: 'normalization',
          host: 'daemon',
          platform: 'darwin',
          occurredAtMs: 1,
          resolution: { state: 'current' },
        },
      ],
    });

    expect(parsed.generation).toBe(7);
    expect(parsed.actionsById['acme.plugin.refresh']?.available).toBe(true);
    expect(parsed).not.toHaveProperty('hooksById');
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'agent.spawnEnv.augment',
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      actionsById: {
        'acme.plugin.refresh': {
          id: 'acme.plugin.refresh',
          pluginId: 'acme.plugin',
          title: 'Refresh Acme',
          scopes: ['settings'],
          surfaces: ['settings'],
          placementBindings: ['primary'],
          dangerLevel: 'safe',
          handler: {
            target: 'daemon',
            exportName: 'refreshAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      executableRegistryPath: '/tmp/acme/registry.json',
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      agentsById: {
        acme: {
          id: 'acme',
          title: 'Acme',
          handler: {
            target: 'daemon',
            exportName: 'loadAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      backendsById: {
        'acme.backend': {
          id: 'acme.backend',
          agentId: 'acme',
          handler: {
            target: 'daemon',
            exportName: 'launchAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      uiDescriptorsById: {
        'acme.plugin.settings': {
          id: 'acme.plugin.settings',
          pluginId: 'acme.plugin',
          surface: 'settings',
          title: 'Acme Settings',
          fields: [
            {
              id: 'enabled',
              type: 'boolean',
              title: 'Enabled',
              componentModule: './SettingsPanel.js',
            },
          ],
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'spawn.augmentEnv',
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'agent.spawnEnv.augment',
          handler: {
            target: 'daemon',
            exportName: 'augmentSpawnEnv',
          },
        },
      },
    }).success).toBe(false);
  });

  it('rejects the retired uiDescriptors projection family', () => {
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      uiDescriptorsById: {},
    }).success).toBe(false);
  });

  it('bounds projected agent-owned provider environment keys without projecting provider credentials', () => {
    const base = {
      v: 2 as const,
      generation: 1,
      agentsById: {
        codex: {
          id: 'codex',
          providerOwnedEnvironmentKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
        },
      },
    };
    expect(PluginProjectionV2Schema.parse(base).agentsById.codex?.providerOwnedEnvironmentKeys)
      .toEqual(['OPENAI_API_KEY', 'CODEX_API_KEY']);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: { codex: { id: 'codex', providerOwnedEnvironmentKeys: ['OPENAI_API_KEY', 'OPENAI_API_KEY'] } },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: { codex: { id: 'codex', providerOwnedEnvironmentKeys: Array.from({ length: 65 }, (_, index) => `PROVIDER_KEY_${index}`) } },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: { codex: { id: 'codex', providerOwnedEnvironmentKeys: ['not-an-env-key'] } },
    }).success).toBe(false);
  });

  it('projects a bounded generation-pinned external-session browse descriptor for an Agent', () => {
    const externalSessions = {
      agent: {
        pluginId: 'acme.external-sessions',
        localId: 'acme-agent',
      },
      generation: 17,
      operations: {
        listCandidates: true,
        resolveLinkIdentity: true,
        pageTranscript: true,
        readAfterTranscript: true,
      },
      sources: [{
        sourceKind: 'acmeArchive',
        schema: {
          fields: [{ name: 'kind', kind: 'literal', value: 'acmeArchive' }],
        },
        key: { segments: [{ kind: 'literal', value: 'acmeArchive' }] },
        instances: [{ kind: 'default', constants: {} }],
      }],
    } as const;
    const base = {
      v: 2 as const,
      generation: 17,
      agentsById: {
        'acme-agent': {
          id: 'acme-agent',
          externalSessions,
        },
      },
    };

    expect(PluginProjectionV2Schema.parse(base).agentsById['acme-agent']?.externalSessions)
      .toEqual(externalSessions);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: {
        'acme-agent': {
          id: 'acme-agent',
          externalSessions: {
            ...externalSessions,
            operations: { ...externalSessions.operations, takeover: true },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: {
        'acme-agent': {
          id: 'acme-agent',
          externalSessions: { ...externalSessions, generation: -1 },
        },
      },
    }).success).toBe(false);
  });

  it('projects secret custody independently from the Settings record scope', () => {
    const accountSettingsWithDaemonSecret = PluginSettingsContributionV2Schema.parse({
      id: 'account-settings',
      version: 1,
      title: 'Account settings',
      target: { kind: 'plugin' },
      scope: 'account',
      fields: [{
        id: 'daemon-secret',
        title: 'Daemon secret',
        schema: { type: 'string' },
        secret: { custody: 'daemon' },
      }],
    });
    const daemonSettingsWithAccountSecret = PluginSettingsContributionV2Schema.parse({
      id: 'daemon-settings',
      version: 1,
      title: 'Daemon settings',
      target: { kind: 'plugin' },
      scope: 'daemon',
      fields: [{
        id: 'account-secret',
        title: 'Account secret',
        schema: { type: 'string' },
        secret: { custody: 'account' },
      }],
    });

    const accountProjection = projectPluginSettingsContributionV2({
      pluginId: 'acme.settings',
      definition: accountSettingsWithDaemonSecret,
    });
    const daemonProjection = projectPluginSettingsContributionV2({
      pluginId: 'acme.settings',
      definition: daemonSettingsWithAccountSecret,
    });

    expect(accountProjection).toMatchObject({
      scope: { kind: 'account' },
      fields: [{
        id: 'daemon-secret',
        control: 'password',
        secretCustody: 'daemon',
        redaction: 'secret',
      }],
    });
    expect(daemonProjection).toMatchObject({
      scope: { kind: 'daemon' },
      fields: [{
        id: 'account-secret',
        control: 'password',
        secretCustody: 'account',
        redaction: 'secret',
      }],
    });
    expect(accountProjection.fields[0]).not.toHaveProperty('defaultValue');
    expect(daemonProjection.fields[0]).not.toHaveProperty('defaultValue');
  });

  it('parses explicit Account settings metadata without exposing setting values', () => {
    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          version: 1,
          title: 'Acme hook settings',
          scope: { kind: 'account' },
          presentation: { sections: [], subagentSections: [] },
          target: { kind: 'plugin' },
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'password',
              secretCustody: 'account',
              displayKey: 'plugins.acme.apiToken.label',
              descriptionKey: 'plugins.acme.apiToken.description',
              redaction: 'secret',
              clearWhenEmpty: 'omit',
              capabilityGates: [],
              permissionGates: [],
            },
            {
              id: 'enabled',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'boolean' },
              valueType: 'boolean',
              control: 'switch',
              secretCustody: null,
              displayKey: 'plugins.acme.enabled.label',
              redaction: 'none',
              clearWhenEmpty: 'persist',
              defaultBooleanValue: true,
              capabilityGates: [],
              permissionGates: [],
            },
          ],
        },
      },
    });

    expect(parsed.settingsById['acme.hooks.settings']?.scope).toEqual({ kind: 'account' });
    expect(parsed.settingsById['acme.hooks.settings']?.fields.map((field) => field.id)).toEqual([
      'apiToken',
      'enabled',
    ]);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          version: 1,
          title: 'Acme hook settings',
          scope: { kind: 'account' },
          presentation: { sections: [], subagentSections: [] },
          target: { kind: 'plugin' },
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'password',
              secretCustody: 'account',
              displayKey: 'plugins.acme.apiToken.label',
              redaction: 'secret',
              clearWhenEmpty: 'omit',
              capabilityGates: [],
              permissionGates: [],
              value: 'super-secret-token',
            },
          ],
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          version: 1,
          title: 'Acme hook settings',
          scope: { kind: 'account' },
          presentation: { sections: [], subagentSections: [] },
          target: { kind: 'plugin' },
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: {
                type: 'string',
                default: 'schema-secret-default',
                enum: ['schema-secret-option'],
              },
              valueType: 'string',
              control: 'password',
              secretCustody: 'account',
              displayKey: 'plugins.acme.apiToken.label',
              redaction: 'secret',
              clearWhenEmpty: 'omit',
              capabilityGates: [],
              permissionGates: [],
            },
          ],
        },
      },
    }).success).toBe(false);

    expect(PluginProjectedSettingsFieldV2Schema.safeParse({
      id: 'legacy-secret',
      kind: 'settings.field',
      version: '1.0.0',
      valueSchema: { type: 'string' },
      valueType: 'string',
      control: 'password',
      displayKey: 'Legacy secret',
      redaction: 'secret',
      clearWhenEmpty: 'omit',
      capabilityGates: [],
      permissionGates: [],
    }).success).toBe(false);
  });

  it('uses one exact binding token and durable occurrence ID for React Native crash reconciliation', () => {
    const token = {
      mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'preview-destination' },
      },
      renderer: { pluginId: 'acme.preview', localId: 'native-preview' },
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      crashStateEpoch: 4,
    } as const;
    const report = {
      kind: 'reportFailure',
      token,
      failureOccurrenceId: '6f46c82c-9516-4e7e-8de8-531152228a01',
      failure: 'render_error',
    } as const;

    expect(DaemonPluginReactNativeCrashReportRequestV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine_1',
      report,
    })).toEqual({
      protocolVersion: 1,
      machineId: 'machine_1',
      report,
    });

    expect(DaemonPluginReactNativeCrashReportRequestV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine_1',
      report: { kind: 'reset', token },
    })).toEqual({
      protocolVersion: 1,
      machineId: 'machine_1',
      report: { kind: 'reset', token },
    });

    expect(DaemonPluginReactNativeCrashReportRequestV1Schema.safeParse({
      protocolVersion: 1,
      machineId: 'machine_1',
      report: {
        ...report,
        failureOccurrenceId: 'not-a-uuid',
      },
    }).success).toBe(false);

    expect(DaemonPluginReactNativeCrashFailureV1Schema.safeParse('load_timeout').success).toBe(true);
    expect(DaemonPluginReactNativeCrashFailureV1Schema.safeParse('invalid_surface_module').success).toBe(true);
    expect(DaemonPluginReactNativeCrashFailureV1Schema.safeParse('load_error').success).toBe(true);
    // Existing daemon crash-state records can retain the previously emitted
    // timeout classification; new UI writers use `load_timeout` instead.
    expect(DaemonPluginReactNativeCrashFailureV1Schema.safeParse('startup_ack_timeout').success).toBe(true);

    expect(DaemonPluginReactNativeCrashReportRequestV1Schema.safeParse({
      protocolVersion: 1,
      machineId: 'machine_1',
      report: {
        surfaceId: 'surface_1',
        cacheIdentity: {
          pluginId: 'acme.preview',
          contributionId: 'native-preview',
          artifactDigest: token.artifactDigest,
          hostAppVersion: '2.0.0',
          hostUiApiVersion: '1.0.0',
          reactVersion: '19.2.0',
          reactNativeVersion: '0.83.4',
          platform: 'ios',
          channel: 'internal',
          nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
          projectionGeneration: 12,
        },
        disabledReason: 'render_error_threshold',
        crashCount: 2,
        observedAtMs: 1_000,
        diagnostics: ['threshold_reached'],
      },
    }).success).toBe(false);

    expect(DaemonPluginReactNativeCrashReportResponseV1Schema.parse({
      protocolVersion: 1,
      ok: false,
      code: 'binding_token_mismatch',
      diagnostics: ['react_native_crash_report_binding_token_mismatch'],
    })).toEqual({
      protocolVersion: 1,
      ok: false,
      code: 'binding_token_mismatch',
      diagnostics: ['react_native_crash_report_binding_token_mismatch'],
    });

    expect(DaemonPluginReactNativeCrashReportResponseV1Schema.parse({
      protocolVersion: 1,
      ok: true,
      token,
      disabled: false,
    })).toEqual({
      protocolVersion: 1,
      ok: true,
      token,
      disabled: false,
    });
  });

  it('rejects unknown projection families and unknown family entry fields', () => {
    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 12,
      familiesById: {
        scmHostingProviders: {
          family: 'scmHostingProviders',
          entriesById: {
            github: {
              id: 'github',
              pluginId: 'acme.scm',
              localId: 'github',
              kind: 'github',
              displayName: 'GitHub',
              description: 'GitHub hosting',
              baseUrl: 'https://github.com',
              urlSafety: {},
              capabilities: {},
              operations: {},
              authService: 'github',
            },
          },
        },
      },
    });

    expect(parsed.familiesById.scmHostingProviders?.entriesById.github).toEqual({
      id: 'github',
      pluginId: 'acme.scm',
      localId: 'github',
      kind: 'github',
      displayName: 'GitHub',
      description: 'GitHub hosting',
      baseUrl: 'https://github.com',
      urlSafety: {},
      capabilities: {},
      operations: {},
      authService: 'github',
    });
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 12,
      familiesById: {
        unknownFamily: {
          family: 'unknownFamily',
          entriesById: {},
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 12,
      familiesById: {
        scmHostingProviders: {
          family: 'scmHostingProviders',
          entriesById: {
            github: {
              ...parsed.familiesById.scmHostingProviders?.entriesById.github,
              hostPattern: 'github.com',
            },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 12,
      familiesById: {
        scmHostingProviders: {
          family: 'scmBackends',
          entriesById: {},
        },
      },
    }).success).toBe(false);
    expect(parsed.agentsById).toEqual({});
    expect(parsed.backendsById).toEqual({});
  });

  it('admits only compiled semantic commands in current plugin-UI projection entries', () => {
    const headerCommand = {
      kind: 'executeAction' as const,
      action: { pluginId: 'acme.ui', localId: 'refresh' },
    };
    const pageCommand = {
      kind: 'openSurface' as const,
      destination: { pluginId: 'acme.ui', localId: 'activity' },
    };
    const binding = {
      destination: { pluginId: 'acme.ui', localId: 'activity' },
      rendererChain: [{ pluginId: 'acme.ui', localId: 'activity-renderer' }],
      renderer: { pluginId: 'acme.ui', localId: 'activity-renderer' },
      container: 'appPage',
      target: { kind: 'app' },
      targetKind: 'app',
      surfaceContextPlacement: 'appSurface',
      instancePolicy: 'singleton',
      platforms: ['android', 'desktop', 'ios', 'web'],
    };
    const projection = {
      v: 2 as const,
      generation: 13,
      familiesById: {
        pluginUi: {
          family: 'pluginUi' as const,
          entriesById: {
            'sessionHeaderAction:acme.ui:refresh': {
              id: 'sessionHeaderAction:acme.ui:refresh',
              pluginId: 'acme.ui',
              contributionKind: 'sessionHeaderAction',
              descriptorId: 'refresh',
              title: 'Refresh',
              icon: 'refresh',
              command: headerCommand,
            },
            'surfacePlacement:acme.ui:activity': {
              id: 'surfacePlacement:acme.ui:activity',
              pluginId: 'acme.ui',
              contributionKind: 'surfacePlacement',
              descriptorId: 'activity',
              generatedV2: true,
              container: 'appPage',
              target: { kind: 'app' },
              binding,
              renderer: { kind: 'declarative' },
              display: { titleKey: 'activity', developerFallback: 'Activity' },
              actions: [],
              headerActions: [{
                id: 'open-activity',
                title: 'Open activity',
                icon: 'action',
                command: pageCommand,
              }],
              availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
            'settingsGroup:acme.ui:tools': {
              id: 'settingsGroup:acme.ui:tools',
              pluginId: 'acme.ui',
              contributionKind: 'settingsGroup',
              group: { id: { pluginId: 'acme.ui', localId: 'tools' }, title: 'Tools' },
            },
            'settingsPage:acme.ui:tools': {
              id: 'settingsPage:acme.ui:tools',
              pluginId: 'acme.ui',
              contributionKind: 'settingsPage',
              descriptorId: 'tools',
              page: { id: { pluginId: 'acme.ui', localId: 'tools' }, title: 'Tools' },
              binding: {
                ...binding,
                destination: { pluginId: 'acme.ui', localId: 'tools' },
                container: 'settingsPage',
              },
              renderer: { kind: 'declarative' },
              availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
          },
        },
      },
    };

    expect(PluginProjectionV2Schema.parse(projection).familiesById.pluginUi?.entriesById)
      .toMatchObject(projection.familiesById.pluginUi.entriesById);

    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        ...projection.familiesById,
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            ...projection.familiesById.pluginUi.entriesById,
            'surfacePlacement:acme.ui:activity': {
              ...projection.familiesById.pluginUi.entriesById['surfacePlacement:acme.ui:activity'],
              binding: {
                ...binding,
                collisionDomain: { container: 'appPage', targetKind: 'app' },
              },
            },
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            ...projection.familiesById.pluginUi.entriesById,
            'sessionHeaderAction:acme.ui:refresh': {
              ...projection.familiesById.pluginUi.entriesById['sessionHeaderAction:acme.ui:refresh'],
              command: { kind: 'executeAction', action: 'refresh' },
            },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            ...projection.familiesById.pluginUi.entriesById,
            'surfacePlacement:acme.ui:activity': {
              ...projection.familiesById.pluginUi.entriesById['surfacePlacement:acme.ui:activity'],
              headerActions: [{
                id: 'open-activity',
                title: 'Open activity',
                command: { kind: 'openSurface', destination: 'activity' },
              }],
            },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            ...projection.familiesById.pluginUi.entriesById,
            'surfacePlacement:acme.ui:activity': {
              ...projection.familiesById.pluginUi.entriesById['surfacePlacement:acme.ui:activity'],
              binding: { ...binding, container: 'detailsTab' },
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('uses a closed React Native artifact-owner union and reserves crash tokens for renderers', () => {
    const crashStateToken = {
      mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'preview-destination' },
      },
      renderer: { pluginId: 'acme.preview', localId: 'native-preview' },
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      crashStateEpoch: 4,
    } as const;
    const cacheIdentity = {
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      hostAppVersion: '2.0.0',
      hostUiApiVersion: '1.0.0',
      reactVersion: '19.0.0',
      reactNativeVersion: '0.83.4',
      expoRuntimeVersion: '0.2.0-native',
      hermesVersion: '0.15.0',
      platform: 'ios',
      channel: 'internal',
      nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}`,
      projectionGeneration: 12,
    } as const;
    const rendererRequest = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
      artifactFamily: 'reactNative',
      artifactOwnerKind: 'renderer',
      machineId: 'm1',
      cacheIdentity,
      crashStateToken,
    });

    expect(rendererRequest.cacheIdentity.artifactDigest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(rendererRequest.cacheIdentity.projectionGeneration).toBe(12);
    expect(rendererRequest.artifactOwnerKind).toBe('renderer');
    expect(rendererRequest.crashStateToken).toEqual(crashStateToken);
    const voiceRequest = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
      artifactFamily: 'reactNative',
      artifactOwnerKind: 'voiceProvider',
      machineId: 'm1',
      cacheIdentity,
    });
    expect(voiceRequest).toEqual({
      artifactFamily: 'reactNative',
      artifactOwnerKind: 'voiceProvider',
      machineId: 'm1',
      cacheIdentity,
    });
    const collectionMigrationsRequest = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
      artifactFamily: 'reactNative',
      artifactOwnerKind: 'collectionMigrations',
      machineId: 'm1',
      cacheIdentity,
    });
    expect(collectionMigrationsRequest).toEqual({
      artifactFamily: 'reactNative',
      artifactOwnerKind: 'collectionMigrations',
      machineId: 'm1',
      cacheIdentity,
    });
    expect(DaemonPluginUiArtifactBytesReadRequestSchema.safeParse({
      ...rendererRequest,
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
      reactNativeWebLoaderCapability: {
        integrated: true,
        installedArtifactLoaderAvailable: true,
      },
    }).success).toBe(false);
    expect(DaemonPluginUiArtifactBytesReadRequestSchema.safeParse({
      ...rendererRequest,
      crashStateToken: {
        ...crashStateToken,
        artifactDigest: `sha256:${'c'.repeat(64)}`,
      },
    }).success).toBe(false);
    expect(DaemonPluginUiArtifactBytesReadRequestSchema.safeParse({
      artifactFamily: 'reactNative',
      machineId: 'm1',
      cacheIdentity,
      crashStateToken,
    }).success).toBe(false);
    expect(DaemonPluginUiArtifactBytesReadRequestSchema.safeParse({
      ...voiceRequest,
      crashStateToken,
    }).success).toBe(false);
    expect(DaemonPluginUiArtifactBytesReadRequestSchema.safeParse({
      ...collectionMigrationsRequest,
      crashStateToken,
    }).success).toBe(false);
    expect(DaemonPluginUiArtifactBytesReadResponseSchema.parse({
      ok: true,
      artifactFamily: 'reactNative',
      artifactOwnerKind: 'renderer',
      cacheIdentity: rendererRequest.cacheIdentity,
      crashStateToken,
      artifact: {
        pluginId: 'acme.preview',
        contributionId: 'native-preview',
        artifactKind: 'reactNativeBundle',
        digest: `sha256:${'a'.repeat(64)}`,
        format: 'plainJs',
        byteSize: 9,
      },
      bytesBase64: 'Ly8gYnVuZGxl',
    })).toMatchObject({
      ok: true,
      artifactOwnerKind: 'renderer',
      crashStateToken,
      artifact: {
        digest: `sha256:${'a'.repeat(64)}`,
        format: 'plainJs',
      },
    });

    expect(DaemonPluginUiArtifactBytesReadResponseSchema.parse({
      ok: true,
      artifactFamily: 'reactNative',
      artifactOwnerKind: 'voiceProvider',
      cacheIdentity: voiceRequest.cacheIdentity,
      artifact: {
        pluginId: 'acme.preview',
        contributionId: 'native-preview',
        artifactKind: 'reactNativeBundle',
        digest: `sha256:${'a'.repeat(64)}`,
        format: 'plainJs',
        byteSize: 9,
      },
      bytesBase64: 'Ly8gYnVuZGxl',
    })).toMatchObject({
      ok: true,
      artifactOwnerKind: 'voiceProvider',
    });
    expect(DaemonPluginUiArtifactBytesReadResponseSchema.safeParse({
      ok: true,
      artifactFamily: 'reactNative',
      artifactOwnerKind: 'voiceProvider',
      cacheIdentity: voiceRequest.cacheIdentity,
      crashStateToken,
      artifact: {
        pluginId: 'acme.preview',
        contributionId: 'native-preview',
        artifactKind: 'reactNativeBundle',
        digest: `sha256:${'a'.repeat(64)}`,
        format: 'plainJs',
        byteSize: 9,
      },
      bytesBase64: 'Ly8gYnVuZGxl',
    }).success).toBe(false);
    expect(DaemonPluginUiArtifactBytesReadResponseSchema.parse({
      ok: true,
      artifactFamily: 'reactNative',
      artifactOwnerKind: 'collectionMigrations',
      cacheIdentity: collectionMigrationsRequest.cacheIdentity,
      artifact: {
        pluginId: 'acme.preview',
        contributionId: 'native-preview',
        artifactKind: 'reactNativeBundle',
        digest: `sha256:${'a'.repeat(64)}`,
        format: 'plainJs',
        byteSize: 9,
      },
      bytesBase64: 'Ly8gYnVuZGxl',
    })).toMatchObject({
      ok: true,
      artifactOwnerKind: 'collectionMigrations',
    });
    expect(protocol.DaemonPluginReactNativeArtifactOwnerKindV1Schema.parse('renderer')).toBe('renderer');
    expect(protocol.DaemonPluginReactNativeArtifactOwnerKindV1Schema.parse('voiceProvider')).toBe('voiceProvider');
    expect(protocol.DaemonPluginReactNativeArtifactOwnerKindV1Schema.parse('collectionMigrations')).toBe('collectionMigrations');

    expect(DaemonPluginUiArtifactBytesReadResponseSchema.parse({
      ok: false,
      code: 'crash_state_token_mismatch',
      diagnostics: ['react_native_crash_state_token_mismatch'],
    })).toEqual({
      ok: false,
      code: 'crash_state_token_mismatch',
      diagnostics: ['react_native_crash_state_token_mismatch'],
    });
  });

  it('keeps packaged hosted-web artifact reads in their own closed renderer family', () => {
    const request = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
      artifactFamily: 'hostedWeb',
      machineId: 'm1',
      cacheIdentity: {
        pluginId: 'acme.preview',
        contributionId: 'hosted-preview',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
        platform: 'web',
        projectionGeneration: 12,
      },
    });

    expect(request).toMatchObject({
      artifactFamily: 'hostedWeb',
      cacheIdentity: {
        artifactDigest: `sha256:${'c'.repeat(64)}`,
        platform: 'web',
      },
    });
    expect(DaemonPluginUiArtifactBytesReadRequestSchema.safeParse({
      ...request,
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
    }).success).toBe(false);
    expect(DaemonPluginUiArtifactBytesReadResponseSchema.parse({
      ok: true,
      artifactFamily: 'hostedWeb',
      cacheIdentity: request.cacheIdentity,
      artifact: {
        pluginId: 'acme.preview',
        contributionId: 'hosted-preview',
        artifactKind: 'hostedWebAsset',
        digest: `sha256:${'c'.repeat(64)}`,
        byteSize: 13,
      },
      bytesBase64: 'PCFkb2N0eXBlIGh0bWw+',
      files: [{
        relativePath: 'hosted/index.html',
        digest: `sha256:${'d'.repeat(64)}`,
        byteSize: 13,
        bytesBase64: 'PCFkb2N0eXBlIGh0bWw+',
      }],
    })).toMatchObject({
      ok: true,
      artifactFamily: 'hostedWeb',
      artifact: {
        artifactKind: 'hostedWebAsset',
      },
    });
  });

});
