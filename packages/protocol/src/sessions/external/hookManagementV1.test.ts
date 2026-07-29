import { describe, expect, it } from 'vitest';

import { getActionSpec, listActionSpecs } from '../../actions/actionSpecs.js';
import { isFeatureId } from '../../features/catalog.js';
import { resolveMachineRpcGovernance } from '../../machines/peer/mediation/rpc/governanceV1.js';
import { resolveMachineRpcRoutePolicy } from '../../machines/peer/mediation/rpc/routePolicyV1.js';
import { RPC_METHODS } from '../../rpc/index.js';
import {
  PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID,
  PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_CHANGES,
  PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_SERIALIZED_BYTES,
  PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_TARGETS,
  PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES,
  PluginSessionHookInstallPreviewV1Schema,
  PluginSessionHookInstallInputV1Schema,
  PluginSessionHookInstallResponseV1Schema,
  PluginSessionHookInstallationMutationInputV1Schema,
  PluginSessionHookInstallationStatusV1Schema,
  PluginSessionHookManagementDiagnosticV1Schema,
  PluginSessionHookStatusInventoryDiagnosticV1Schema,
  PluginSessionHookStatusInventoryRowV1Schema,
  PluginSessionHookStatusInputV1Schema,
  PluginSessionHookStatusResponseV1Schema,
  PluginSessionHookToggleResponseV1Schema,
  PluginSessionHookUninstallResponseV1Schema,
  type PluginSessionHookStatusInputV1,
} from './hookManagementV1.js';

const agent = {
  pluginId: 'acme.external-sessions',
  localId: 'claude',
} as const;

const previewId = `hook-install-preview:v1:${'a'.repeat(64)}` as const;

function installPreview(input: Readonly<{
  command?: string;
  targets?: number;
  changesPerTarget?: number;
}> = {}) {
  const targetCount = input.targets ?? 1;
  const changesPerTarget = input.changesPerTarget ?? 1;
  return {
    previewId,
    targets: Array.from({ length: targetCount }, (_, targetIndex) => ({
      targetId: `settings-${targetIndex}`,
      absolutePath: `/home/alice/.agent/settings-${targetIndex}.json`,
      changes: Array.from({ length: changesPerTarget }, (_, changeIndex) => ({
        kind: 'append_json_array_entry' as const,
        collectionId: `hooks-${targetIndex}`,
        eventId: `event-${targetIndex}-${changeIndex}`,
        nativeEventName: `NativeEvent${changeIndex}`,
        entry: {
          matcher: null,
          hooks: [{
            type: 'command' as const,
            command: input.command ?? '/opt/happier hook event',
            timeout: 500,
          }],
        },
      })),
    })),
  };
}

describe('plugin-generic session-hook management contracts', () => {
  it('reads one bounded machine inventory with an optional exact Agent filter and pagination', () => {
    const unpaginatedInput = {
      machineId: 'machine-1',
      intent: 'passive_inventory',
    } satisfies PluginSessionHookStatusInputV1;
    expect(PluginSessionHookStatusInputV1Schema.parse(unpaginatedInput)).toEqual({
      machineId: 'machine-1',
      intent: 'passive_inventory',
      limit: 50,
    });
    expect(PluginSessionHookStatusInputV1Schema.parse({
      machineId: 'machine-1',
      intent: 'passive_inventory',
      agent,
      cursor: 'opaque-cursor',
      limit: 12,
    })).toEqual({
      machineId: 'machine-1',
      intent: 'passive_inventory',
      agent,
      cursor: 'opaque-cursor',
      limit: 12,
    });
    expect(PluginSessionHookStatusInputV1Schema.parse({
      machineId: 'machine-1',
      intent: 'install_preview',
      agent,
    })).toEqual({
      machineId: 'machine-1',
      intent: 'install_preview',
      agent,
    });
    expect(PluginSessionHookStatusInputV1Schema.parse({
      machineId: 'machine-1',
      intent: 'installation_recheck',
      agent,
      installationId: 'installation-1',
    })).toEqual({
      machineId: 'machine-1',
      intent: 'installation_recheck',
      agent,
      installationId: 'installation-1',
    });

    for (const input of [
      { machineId: 'machine-1' },
      { machineId: 'machine-1', intent: 'unknown' },
      { machineId: 'machine-1', intent: 'explicit_recheck' },
      {
        machineId: 'machine-1',
        intent: 'install_preview',
      },
      {
        machineId: 'machine-1',
        intent: 'install_preview',
        agent,
        cursor: 'not-allowed',
      },
      {
        machineId: 'machine-1',
        intent: 'install_preview',
        agent,
        limit: 1,
      },
      {
        machineId: 'machine-1',
        intent: 'installation_recheck',
        agent,
      },
      {
        machineId: 'machine-1',
        intent: 'installation_recheck',
        agent,
        installationId: 'installation-1',
        cursor: 'not-allowed',
      },
      {
        machineId: 'machine-1',
        intent: 'installation_recheck',
        agent,
        installationId: 'installation-1',
        limit: 1,
      },
    ]) {
      expect(PluginSessionHookStatusInputV1Schema.safeParse(input).success).toBe(false);
    }

    for (const input of [
      {
        machineId: 'machine-1',
        intent: 'passive_inventory',
        agent,
        adapterId: 'obsolete-adapter',
      },
      { machineId: 'machine-1', intent: 'passive_inventory', limit: 0 },
      { machineId: 'machine-1', intent: 'passive_inventory', limit: 51 },
      { machineId: 'machine-1', intent: 'passive_inventory', limit: 1.5 },
      {
        machineId: 'machine-1',
        intent: 'passive_inventory',
        cursor: 'c'.repeat(4_097),
      },
      { machineId: 'm'.repeat(513), intent: 'passive_inventory' },
      {
        machineId: 'machine-1',
        intent: 'passive_inventory',
        agent: { pluginId: `${'p'.repeat(500)}.${'q'.repeat(12)}`, localId: 'claude' },
      },
      {
        machineId: 'machine-1',
        intent: 'passive_inventory',
        agent: { pluginId: 'acme.external-sessions', localId: 'a'.repeat(513) },
      },
      {
        machineId: 'machine-1',
        intent: 'passive_inventory',
        pluginId: 'acme.external-sessions',
        agentId: 'claude',
      },
      {
        machineId: 'machine-1',
        intent: 'passive_inventory',
        qualifiedContributionId: 'acme.external-sessions/agents/claude',
      },
    ]) {
      expect(PluginSessionHookStatusInputV1Schema.safeParse(input).success).toBe(false);
    }
  });

  it('requires an exact preview identity for install while keeping later mutations installation-qualified', () => {
    expect(PluginSessionHookInstallInputV1Schema.parse({
      machineId: 'machine-1',
      agent,
      expectedPreviewId: previewId,
    })).toEqual({
      machineId: 'machine-1',
      agent,
      expectedPreviewId: previewId,
    });
    expect(PluginSessionHookInstallInputV1Schema.safeParse({
      machineId: 'machine-1',
      agent,
    }).success).toBe(false);
    expect(PluginSessionHookInstallInputV1Schema.safeParse({
      machineId: 'machine-1',
      agent,
      expectedPreviewId: `hook-install-preview:v1:${'A'.repeat(64)}`,
    }).success).toBe(false);
    expect(PluginSessionHookInstallInputV1Schema.safeParse({
      machineId: 'machine-1',
      agent,
      expectedPreviewId: previewId,
      installationId: 'caller-chosen-installation',
    }).success).toBe(false);
    const installActionSpec = getActionSpec('plugins.sessionHooks.install');
    expect(installActionSpec.inputSchema.safeParse({
      machineId: 'machine-1',
      agent,
      expectedPreviewId: previewId,
    }).success).toBe(true);
    expect(installActionSpec.inputSchema.safeParse({
      machineId: 'machine-1',
      agent,
    }).success).toBe(false);

    expect(PluginSessionHookInstallationMutationInputV1Schema.parse({
      machineId: 'machine-1',
      agent,
      installationId: 'install-1',
    }).installationId).toBe('install-1');

    for (const schema of [
      PluginSessionHookInstallInputV1Schema,
      PluginSessionHookInstallationMutationInputV1Schema,
    ]) {
      expect(schema.safeParse({
        machineId: 'machine-1',
        agent,
        adapterId: 'obsolete-adapter',
        ...(schema === PluginSessionHookInstallationMutationInputV1Schema
          ? { installationId: 'install-1' }
          : { expectedPreviewId: previewId }),
      }).success).toBe(false);
    }
  });

  it('accepts only the strict bounded concrete install-preview shape', () => {
    expect(PluginSessionHookInstallPreviewV1Schema.parse(installPreview())).toEqual(
      installPreview(),
    );
    expect(PluginSessionHookInstallPreviewV1Schema.parse(
      installPreview({
        targets: PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_TARGETS,
        changesPerTarget:
          PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_CHANGES
          / PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_TARGETS,
      }),
    ).targets).toHaveLength(PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_TARGETS);
    const maxPathPreview = installPreview();
    maxPathPreview.targets[0]!.absolutePath = `/${'x'.repeat(4_095)}`;
    expect(PluginSessionHookInstallPreviewV1Schema.safeParse(maxPathPreview).success)
      .toBe(true);
    for (const absolutePath of [
      'C:\\Users\\alice\\.agent\\settings.json',
      '\\\\server\\share\\.agent\\settings.json',
    ]) {
      const platformPreview = installPreview();
      platformPreview.targets[0]!.absolutePath = absolutePath;
      expect(PluginSessionHookInstallPreviewV1Schema.safeParse(platformPreview).success)
        .toBe(true);
    }

    const oneTarget = installPreview();
    const oneChange = oneTarget.targets[0]!.changes[0]!;
    for (const invalid of [
      { ...oneTarget, previewId: `hook-install-preview:v1:${'A'.repeat(64)}` },
      { ...oneTarget, previewId: `hook-install-preview:v2:${'a'.repeat(64)}` },
      { ...oneTarget, previewId: 'hook-install-preview:v1:short' },
      { ...oneTarget, targets: [] },
      installPreview({
        targets: PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_TARGETS + 1,
      }),
      {
        ...oneTarget,
        targets: [{
          ...oneTarget.targets[0],
          changes: [],
        }],
      },
      installPreview({
        changesPerTarget: PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_CHANGES + 1,
      }),
      installPreview({
        targets: 2,
        changesPerTarget: 33,
      }),
      {
        ...oneTarget,
        targets: [
          oneTarget.targets[0],
          {
            ...oneTarget.targets[0],
            changes: [{
              ...oneChange,
              eventId: 'different-event',
            }],
          },
        ],
      },
      {
        ...oneTarget,
        targets: [
          oneTarget.targets[0],
          {
            ...oneTarget.targets[0],
            absolutePath: '/home/alice/.agent/different.json',
            changes: [{
              ...oneChange,
              eventId: 'different-event',
            }],
          },
        ],
      },
      {
        ...oneTarget,
        targets: [
          oneTarget.targets[0],
          {
            ...oneTarget.targets[0],
            targetId: 'different-target',
            changes: [{
              ...oneChange,
              eventId: 'different-event',
            }],
          },
        ],
      },
      {
        ...oneTarget,
        targets: [
          oneTarget.targets[0],
          {
            ...oneTarget.targets[0],
            targetId: 'different-target',
            absolutePath: '/home/alice/.agent/different.json',
          },
        ],
      },
      {
        ...oneTarget,
        targets: [{
          ...oneTarget.targets[0],
          absolutePath: 'relative/settings.json',
        }],
      },
      {
        ...oneTarget,
        targets: [{
          ...oneTarget.targets[0],
          absolutePath: '/home/alice/.agent/settings\u0000.json',
        }],
      },
      {
        ...oneTarget,
        targets: [{
          ...oneTarget.targets[0],
          absolutePath: `/${'x'.repeat(4_096)}`,
        }],
      },
      {
        ...oneTarget,
        targets: [{
          ...oneTarget.targets[0],
          changes: [{ ...oneChange, kind: 'replace_whole_config' }],
        }],
      },
      {
        ...oneTarget,
        targets: [{
          ...oneTarget.targets[0],
          changes: [{
            ...oneChange,
            entry: {
              ...oneChange.entry,
              hooks: [{
                type: 'shell',
                command: '/opt/happier hook event',
                timeout: 500,
              }],
            },
          }],
        }],
      },
      {
        ...oneTarget,
        targets: [{
          ...oneTarget.targets[0],
          changes: [{
            ...oneChange,
            entry: {
              ...oneChange.entry,
              hooks: [
                oneChange.entry.hooks[0],
                oneChange.entry.hooks[0],
              ],
            },
          }],
        }],
      },
      {
        ...oneTarget,
        targets: [{
          ...oneTarget.targets[0],
          changes: [{
            ...oneChange,
            entry: {
              ...oneChange.entry,
              hooks: [{
                ...oneChange.entry.hooks[0],
                command: 'contains\u0000nul',
              }],
            },
          }],
        }],
      },
      {
        ...oneTarget,
        targets: [{
          ...oneTarget.targets[0],
          changes: [{
            ...oneChange,
            entry: {
              ...oneChange.entry,
              hooks: [{
                ...oneChange.entry.hooks[0],
                timeout: 0,
              }],
            },
          }],
        }],
      },
      {
        ...oneTarget,
        targets: [{
          ...oneTarget.targets[0],
          changes: [{
            ...oneChange,
            entry: {
              ...oneChange.entry,
              secret: 'must-not-pass',
            },
          }],
        }],
      },
      { ...oneTarget, generation: 'must-not-pass' },
      { ...oneTarget, installationIdentity: 'must-not-pass' },
      { ...oneTarget, principal: 'must-not-pass' },
      { ...oneTarget, rawPayload: { prompt: 'must-not-pass' } },
      { ...oneTarget, source: { raw: true } },
      { ...oneTarget, linkData: { raw: true } },
      { ...oneTarget, config: { whole: true } },
      { ...oneTarget, wholeConfig: { whole: true } },
    ]) {
      expect(PluginSessionHookInstallPreviewV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('accepts an install preview at 64 KiB and rejects one byte more', () => {
    const emptyCommandPreview = installPreview({ command: '' });
    const fixedBytes =
      new TextEncoder().encode(JSON.stringify(emptyCommandPreview)).byteLength;
    const exactLimitPreview = installPreview({
      command: 'x'.repeat(
        PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_SERIALIZED_BYTES - fixedBytes,
      ),
    });
    const aboveLimitPreview = installPreview({
      command: 'x'.repeat(
        PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_SERIALIZED_BYTES - fixedBytes + 1,
      ),
    });

    expect(new TextEncoder().encode(JSON.stringify(exactLimitPreview)).byteLength)
      .toBe(PLUGIN_SESSION_HOOK_INSTALL_PREVIEW_MAX_SERIALIZED_BYTES);
    expect(PluginSessionHookInstallPreviewV1Schema.safeParse(exactLimitPreview).success)
      .toBe(true);
    expect(PluginSessionHookInstallPreviewV1Schema.safeParse(aboveLimitPreview).success)
      .toBe(false);
  });

  it('returns a qualified row for every portable installation state', () => {
    expect(PluginSessionHookInstallationStatusV1Schema.parse({
      state: 'installed_enabled',
      installationId: 'install-1',
    })).toEqual({
      state: 'installed_enabled',
      installationId: 'install-1',
    });
    expect(PluginSessionHookInstallationStatusV1Schema.safeParse({
      state: 'installed_enabled',
    }).success).toBe(false);
    expect(PluginSessionHookInstallationStatusV1Schema.safeParse({
      state: 'not_installed',
      installationId: 'stale-install',
    }).success).toBe(false);
    expect(PluginSessionHookInstallationStatusV1Schema.safeParse({
      state: 'not_installed',
    }).success).toBe(true);
    expect(PluginSessionHookInstallationStatusV1Schema.parse({
      state: 'not_installed',
      installPreview: installPreview(),
    }).state).toBe('not_installed');
    expect(PluginSessionHookInstallationStatusV1Schema.parse({
      state: 'needs_attention',
      diagnostic: {
        code: 'hook_configuration_requires_attention',
        severity: 'warning',
        message: 'Review the Agent hook configuration.',
        remediation: { kind: 'retry' },
      },
    })).toEqual({
      state: 'needs_attention',
      diagnostic: {
        code: 'hook_configuration_requires_attention',
        severity: 'warning',
        message: 'Review the Agent hook configuration.',
        remediation: { kind: 'retry' },
      },
    });
    expect(PluginSessionHookInstallationStatusV1Schema.safeParse({
      state: 'needs_attention',
    }).success).toBe(false);
    expect(PluginSessionHookInstallationStatusV1Schema.parse({
      state: 'needs_attention',
      installationId: 'install-1',
      diagnostic: {
        code: 'hook_configuration_requires_attention',
        severity: 'warning',
      },
    }).installationId).toBe('install-1');
    expect(PluginSessionHookInstallationStatusV1Schema.parse({
      state: 'unsupported',
      reason: 'version_unsupported',
    }).state).toBe('unsupported');
    expect(PluginSessionHookInstallationStatusV1Schema.parse({
      state: 'unsupported',
      reason: 'installation_unsupported',
    }).state).toBe('unsupported');
    expect(PluginSessionHookInstallationStatusV1Schema.parse({
      state: 'unavailable',
      installationId: 'install-1',
    }).state).toBe('unavailable');
    expect(PluginSessionHookInstallationStatusV1Schema.safeParse({
      state: 'unavailable',
    }).success).toBe(false);
    expect(PluginSessionHookInstallationStatusV1Schema.safeParse({
      state: 'installed_enabled',
      installationId: 'install-1',
      installPreview: installPreview(),
    }).success).toBe(false);
    expect(PluginSessionHookInstallationStatusV1Schema.safeParse({
      state: 'needs_trust',
      installationId: 'install-1',
    }).success).toBe(false);

    expect(PluginSessionHookStatusInventoryRowV1Schema.parse({
      agent,
      status: {
        state: 'installed_disabled',
        installationId: 'install-1',
      },
    })).toEqual({
      agent,
      status: {
        state: 'installed_disabled',
        installationId: 'install-1',
      },
    });

    expect(PluginSessionHookManagementDiagnosticV1Schema.parse({
      code: 'version_unsupported',
      retryable: false,
    }).code).toBe('version_unsupported');
    expect(PluginSessionHookManagementDiagnosticV1Schema.parse({
      code: 'installation_unsupported',
      retryable: false,
    }).code).toBe('installation_unsupported');
    expect(PluginSessionHookManagementDiagnosticV1Schema.safeParse({
      code: 'recipe_unsupported',
      retryable: false,
    }).success).toBe(false);

    for (const unsafe of [
      { token: 'raw-secret' },
      { path: '/Users/alice/.agent/config.json' },
      { payload: { prompt: 'secret prompt' } },
      { environment: { API_KEY: 'secret' } },
      { message: 'token=raw-secret path=/Users/alice/.agent/config.json' },
      { variantId: 'host-internal-variant' },
    ]) {
      expect(PluginSessionHookManagementDiagnosticV1Schema.safeParse({
        code: 'operation_failed',
        retryable: false,
        ...unsafe,
      }).success).toBe(false);
    }
  });

  it('returns a bounded, path-free inventory and uses diagnostics as the sole partial-read signal', () => {
    expect(PluginSessionHookStatusResponseV1Schema.parse({
      ok: true,
      rows: [{
        agent,
        status: { state: 'not_installed', installPreview: installPreview() },
      }],
      nextCursor: null,
      diagnostics: [],
    })).toEqual({
      ok: true,
      rows: [{
        agent,
        status: { state: 'not_installed', installPreview: installPreview() },
      }],
      nextCursor: null,
      diagnostics: [],
    });

    expect(PluginSessionHookStatusResponseV1Schema.parse({
      ok: true,
      rows: [],
      nextCursor: 'next-page',
      diagnostics: [{
        code: 'installation_record_read_failed',
        retryable: true,
      }],
    }).diagnostics).toHaveLength(1);

    for (const code of [
      'installation_record_invalid',
      'installation_record_read_failed',
    ] as const) {
      expect(PluginSessionHookStatusInventoryDiagnosticV1Schema.parse({
        code,
        retryable: code === 'installation_record_read_failed',
      }).code).toBe(code);
    }

    expect(PluginSessionHookStatusResponseV1Schema.safeParse({
      ok: true,
      rows: Array.from({ length: 51 }, () => ({
        agent,
        status: { state: 'not_installed', installPreview: installPreview() },
      })),
      nextCursor: null,
      diagnostics: [],
    }).success).toBe(false);
    expect(PluginSessionHookStatusResponseV1Schema.safeParse({
      ok: true,
      rows: [],
      nextCursor: null,
      diagnostics: Array.from({ length: 33 }, () => ({
        code: 'installation_record_invalid',
        retryable: false,
      })),
    }).success).toBe(false);

    for (const unsafe of [
      { code: 'operation_failed', retryable: false },
      {
        code: 'installation_record_invalid',
        retryable: false,
        path: '/Users/alice/.happier/private-record.json',
      },
      {
        code: 'installation_record_read_failed',
        retryable: true,
        content: 'private record content',
      },
    ]) {
      expect(PluginSessionHookStatusInventoryDiagnosticV1Schema.safeParse(unsafe).success).toBe(false);
    }
  });

  it('rejects a status inventory above the canonical serialized UTF-8 ceiling', () => {
    const createResponseWithMessageBytes = (messageBytes: number) => ({
      ok: true as const,
      rows: [{
        agent,
        status: {
          state: 'needs_attention' as const,
          diagnostic: {
            code: 'hook_configuration_requires_attention',
            severity: 'warning' as const,
            message: 'x'.repeat(messageBytes),
          },
        },
      }],
      nextCursor: null,
      diagnostics: [],
    });
    const oneByteResponse = createResponseWithMessageBytes(1);
    const fixedBytes = new TextEncoder().encode(JSON.stringify(oneByteResponse)).byteLength - 1;
    const exactLimitResponse = createResponseWithMessageBytes(
      PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES - fixedBytes,
    );
    const aboveLimitResponse = createResponseWithMessageBytes(
      PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES - fixedBytes + 1,
    );

    expect(new TextEncoder().encode(JSON.stringify(exactLimitResponse)).byteLength)
      .toBe(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES);
    expect(PluginSessionHookStatusResponseV1Schema.safeParse(exactLimitResponse).success).toBe(true);
    expect(PluginSessionHookStatusResponseV1Schema.safeParse(aboveLimitResponse).success).toBe(false);
  });

  it('keeps install, toggle, and uninstall outcomes token-free', () => {
    expect(PluginSessionHookInstallResponseV1Schema.parse({
      ok: true,
      status: { state: 'installed_disabled', installationId: 'install-1' },
    }).ok).toBe(true);
    expect(PluginSessionHookToggleResponseV1Schema.parse({
      ok: true,
      status: { state: 'installed_enabled', installationId: 'install-1' },
    }).ok).toBe(true);
    expect(PluginSessionHookUninstallResponseV1Schema.parse({
      ok: true,
      status: { state: 'not_installed' },
    }).ok).toBe(true);
    expect(PluginSessionHookUninstallResponseV1Schema.safeParse({
      ok: true,
      status: {
        state: 'not_installed',
        installPreview: installPreview(),
      },
    }).success).toBe(false);

    for (const [schema, unsafe] of [
      [PluginSessionHookInstallResponseV1Schema, { tokenTransition: 'rotated' }],
      [PluginSessionHookToggleResponseV1Schema, { token: 'raw-secret' }],
      [PluginSessionHookUninstallResponseV1Schema, { tokenRevocation: 'revoked' }],
    ] as const) {
      expect(schema.safeParse({
        ok: true,
        status: schema === PluginSessionHookUninstallResponseV1Schema
          ? { state: 'not_installed' }
          : { state: 'installed_enabled', installationId: 'install-1' },
        ...unsafe,
      }).success).toBe(false);
    }

    for (const unsafe of [
      { path: '/Users/alice/.agent/config.json' },
      { payload: { prompt: 'secret prompt' } },
      { variantId: 'host-internal-variant' },
    ]) {
      expect(PluginSessionHookStatusResponseV1Schema.safeParse({
        ok: true,
        rows: [],
        nextCursor: null,
        diagnostics: [],
        ...unsafe,
      }).success).toBe(false);
    }
  });

  it('registers qualified management ActionSpecs under the deployed fail-closed feature id', () => {
    expect(PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID).toBe('sessions.direct');
    expect(isFeatureId(PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID)).toBe(true);

    const expected = [
      ['plugins.sessionHooks.status.get', RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET, 'read'],
      ['plugins.sessionHooks.install', RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL, 'write'],
      ['plugins.sessionHooks.disable', RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_DISABLE, 'write'],
      ['plugins.sessionHooks.enable', RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_ENABLE, 'write'],
      ['plugins.sessionHooks.uninstall', RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL, 'danger'],
    ] as const;

    expect(
      listActionSpecs().filter((spec) => spec.id.startsWith('plugins.sessionHooks.')).map((spec) => spec.id),
    ).toEqual(expected.map(([actionId]) => actionId));

    for (const [actionId, rpcMethod, sideEffectClass] of expected) {
      const spec = getActionSpec(actionId);
      expect(spec.bindings?.rpcMethod).toBe(rpcMethod);
      expect(spec.sideEffectClass).toBe(sideEffectClass);
      expect(spec.surfaces).toMatchObject({ rpc: true, sdk: false });
      expect(resolveMachineRpcGovernance(rpcMethod)).toEqual({
        rpcClassification: 'action_spec_bound',
        actionSpecId: actionId,
      });
      expect(resolveMachineRpcRoutePolicy(rpcMethod)).toMatchObject({
        rpcClassification: 'action_spec_bound',
        actionSpecId: actionId,
        routeClass: sideEffectClass === 'read' ? 'direct_ephemeral' : 'direct_medium_risk_receipted',
      });
    }
  });
});
