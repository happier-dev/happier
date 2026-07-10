import { describe, expect, it } from 'vitest';

import {
  ExtensionContributionV2Schema,
  ExtensionManifestV2Schema,
  ExtensionMarketplaceCatalogV1Schema,
  ExtensionPermissionDeclarationV1Schema,
  ExtensionRuntimeApiV1Schema,
} from '../../index.js';

describe('extension manifest v2 contracts', () => {
  it('exports the canonical v2 extension schemas through the protocol root', () => {
    expect(typeof ExtensionManifestV2Schema.safeParse).toBe('function');
    expect(typeof ExtensionContributionV2Schema.safeParse).toBe('function');
    expect(typeof ExtensionPermissionDeclarationV1Schema.safeParse).toBe('function');
    expect(typeof ExtensionRuntimeApiV1Schema.safeParse).toBe('function');
    expect(typeof ExtensionMarketplaceCatalogV1Schema.safeParse).toBe('function');
  });

  it('parses a representative manifest with typed contribution kinds and permissions', () => {
    const parsed = ExtensionManifestV2Schema.parse({
      schemaVersion: 2,
      id: 'acme.extension',
      version: '1.2.3',
      displayName: 'Acme Extension',
      description: 'Adds Acme extension capabilities',
      engines: {
        happier: '^0.2.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['actions', 'tools', 'commands', 'hooks', 'resources', 'uiDescriptors'],
      },
      targets: {
        daemon: {
          entry: './daemon.js',
        },
      },
      permissions: [
        {
          capability: 'actions.execute',
          reason: 'Run the extension action when selected by the user',
        },
        {
          capability: 'ui.descriptors',
          reason: 'Render settings fields through host-owned UI',
        },
      ],
      marketplace: {
        sourceUrl: 'https://marketplace.example.test/catalog.json',
        categories: ['productivity'],
      },
      contributions: [
        {
          kind: 'action',
          id: 'acme.extension.refresh',
          title: 'Refresh Acme',
          description: 'Refreshes Acme data',
          scopes: ['settings'],
          surfaces: ['settings'],
          placement: 'primary',
          dangerLevel: 'safe',
          permissions: ['actions.execute'],
          handler: {
            target: 'daemon',
            exportName: 'refreshAcme',
          },
          availability: {
            features: ['extensions.actions'],
          },
        },
        {
          kind: 'tool',
          id: 'acme.extension.search',
          name: 'acme_extension_search',
          title: 'Search Acme',
          safety: 'safe',
          surfaces: {
            cli: false,
            mcp: true,
            session_agent: true,
          },
          inputSchema: {
            type: 'object',
          },
          handler: {
            target: 'daemon',
            exportName: 'searchAcme',
          },
        },
        {
          kind: 'command',
          id: 'acme.extension.reload',
          command: 'acme reload',
          rootHelpLabel: 'happier acme reload',
          rootHelpDescription: 'Reload Acme',
          handler: {
            target: 'daemon',
            exportName: 'reloadAcme',
          },
        },
        {
          kind: 'resource',
          id: 'acme.extension.prompt',
          resourceKind: 'prompt',
          path: 'resources/prompt.md',
          digest: 'sha256:abc123',
        },
        {
          kind: 'uiDescriptor',
          id: 'acme.extension.settings',
          surface: 'settings',
          title: 'Acme Settings',
          fields: [
            {
              id: 'enabled',
              type: 'boolean',
              title: 'Enabled',
            },
          ],
        },
        {
          kind: 'hook',
          hookApiVersion: 1,
          id: 'agent.request.before',
          category: 'augmentation',
          scope: 'agent',
          executionKind: 'augment',
          handler: {
            target: 'plugin',
            exportName: 'beforeAgentRequest',
          },
          priority: 10,
        },
      ],
    });

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.runtime.capabilities).toContain('actions');
    expect(parsed.permissions.map((entry) => entry.capability)).toEqual([
      'actions.execute',
      'ui.descriptors',
    ]);
    expect(parsed.contributions.map((entry) => entry.kind)).toEqual([
      'action',
      'tool',
      'command',
      'resource',
      'uiDescriptor',
      'hook',
    ]);
  });

  it('rejects executable UI/server targets and concrete customAcp plugin targets', () => {
    expect(ExtensionManifestV2Schema.safeParse({
      schemaVersion: 2,
      id: 'acme.extension',
      version: '1.0.0',
      displayName: 'Acme Extension',
      engines: {
        happier: '^0.2.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['actions'],
      },
      targets: {
        daemon: {
          entry: './daemon.js',
        },
        ui: {
          entry: './ui.js',
        },
      },
      contributions: [],
    }).success).toBe(false);

    expect(ExtensionContributionV2Schema.safeParse({
      kind: 'backend',
      id: 'customAcp',
      providerId: 'acme.extension',
      runtimeKind: 'acp',
      target: {
        sourceKind: 'customAcp',
        id: 'customAcp',
      },
    }).success).toBe(false);
  });

  it('accepts final plugin ACP backend wire and rejects the legacy loose ACP carrier', () => {
    const parsed = ExtensionContributionV2Schema.parse({
      kind: 'backend',
      kindVersion: 1,
      id: 'acme.extension.acp',
      providerId: 'acme.extension',
      engine: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
            args: ['acp'],
          },
          timeouts: {
            initMs: 1,
            initDelayMs: 2,
            idleMs: 3,
            toolCallMs: 4,
            promptLivenessMs: 5,
            postPromptNoUpdatesMs: 6,
            postToolCallIdleMs: 7,
            idleWithoutAssistantMessageMs: 8,
            preToolCallIdleMs: 9,
            futureTimeoutMs: 10,
          },
          futureTransportHint: true,
        },
        ux: {
          title: 'Acme Agent',
          futureUxHint: 'preserved',
        },
        mcp: {
          policy: 'drop',
          futureMcpHint: 'preserved',
        },
        futureEngineHint: 'preserved',
      },
      capabilities: {},
      surfaceHandlers: [],
      futureBackendHint: 'preserved',
    });

    expect(parsed).toMatchObject({
      kind: 'backend',
      id: 'acme.extension.acp',
      engine: {
        kind: 'acp',
        futureEngineHint: 'preserved',
        transport: {
          futureTransportHint: true,
          timeouts: {
            initMs: 1,
            preToolCallIdleMs: 9,
            futureTimeoutMs: 10,
          },
        },
        ux: {
          futureUxHint: 'preserved',
        },
        mcp: {
          futureMcpHint: 'preserved',
        },
      },
      futureBackendHint: 'preserved',
    });

    expect(ExtensionContributionV2Schema.safeParse({
      kind: 'backend',
      kindVersion: 1,
      id: 'acme.extension.acp',
      providerId: 'acme.extension',
      engine: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
          timeouts: {
            handshakeMs: 20,
          },
        },
        ux: {
          title: 'Acme Agent',
        },
        timeouts: {
          initMs: 1,
        },
      },
      capabilities: {},
      surfaceHandlers: [],
    }).success).toBe(false);

    expect(ExtensionContributionV2Schema.safeParse({
      kind: 'backend',
      kindVersion: 1,
      id: 'acme.extension.acp',
      providerId: 'acme.extension',
      runtimeKind: 'acp',
      acp: {
        command: 'acme-agent',
      },
      capabilities: {},
      surfaceHandlers: [],
    }).success).toBe(false);
  });

  it('accepts minimal ACP manifest UX metadata per T.4', () => {
    expect(ExtensionContributionV2Schema.safeParse({
      kind: 'backend',
      kindVersion: 1,
      id: 'acme.extension.minimal-acp',
      providerId: 'acme.extension',
      engine: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
      },
      capabilities: {},
      surfaceHandlers: [],
    }).success).toBe(true);

    expect(ExtensionContributionV2Schema.safeParse({
      kind: 'backend',
      kindVersion: 1,
      id: 'acme.extension.named-acp',
      providerId: 'acme.extension',
      engine: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        ux: {
          name: 'Acme Named Agent',
        },
      },
      capabilities: {},
      surfaceHandlers: [],
    }).success).toBe(true);
  });

  it('keeps strict validation for non-manifest executable policy records', () => {
    expect(ExtensionPermissionDeclarationV1Schema.safeParse({
      capability: 'actions.execute',
      reason: 'Run the extension action when selected by the user',
      executablePath: '/tmp/acme/daemon.js',
    }).success).toBe(false);

    expect(ExtensionRuntimeApiV1Schema.safeParse({
      apiVersion: 1,
      capabilities: ['actions'],
      privateApiToken: 'secret',
    }).success).toBe(false);

    expect(ExtensionMarketplaceCatalogV1Schema.safeParse({
      schemaVersion: 1,
      sourceKind: 'user',
      entries: [
        {
          id: 'acme.extension',
          manifestId: 'acme.extension',
          title: 'Acme Extension',
          sourceUrl: 'https://marketplace.example.test/acme.json',
          installScript: 'curl https://example.test/install.sh | sh',
        },
      ],
    }).success).toBe(false);
  });

  it('rejects unsafe plugin ids in v2 manifests', () => {
    for (const pluginId of [
      '../escape',
      'acme/escape',
      'acme..plugin',
      '.hidden',
      '__proto__',
      'acme.__proto__.plugin',
      'constructor',
      'prototype.plugin',
    ]) {
      expect(ExtensionManifestV2Schema.safeParse({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Unsafe Extension',
        engines: {
          happier: '^0.2.0',
        },
        runtime: {
          apiVersion: 1,
          capabilities: ['actions'],
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
        },
        contributions: [],
      }).success).toBe(false);
    }
  });

  it('requires host confirmation metadata for non-safe plugin actions', () => {
    expect(ExtensionContributionV2Schema.safeParse({
      kind: 'action',
      id: 'acme.extension.deleteRemote',
      title: 'Delete Remote Acme Data',
      scopes: ['settings'],
      surfaces: ['settings'],
      placement: 'primary',
      dangerLevel: 'destructive',
      handler: {
        target: 'daemon',
        exportName: 'deleteRemoteAcmeData',
      },
    }).success).toBe(false);

    expect(ExtensionContributionV2Schema.safeParse({
      kind: 'action',
      id: 'acme.extension.deleteRemote',
      title: 'Delete Remote Acme Data',
      scopes: ['settings'],
      surfaces: ['settings'],
      placement: 'primary',
      dangerLevel: 'destructive',
      confirmation: {
        title: 'Delete remote data?',
        confirmLabel: 'Delete',
      },
      handler: {
        target: 'daemon',
        exportName: 'deleteRemoteAcmeData',
      },
    }).success).toBe(true);
  });

  it('requires daemon handler references to name an export or activation registration', () => {
    expect(ExtensionContributionV2Schema.safeParse({
      kind: 'action',
      id: 'acme.extension.refresh',
      title: 'Refresh Acme',
      scopes: ['settings'],
      surfaces: ['settings'],
      placement: 'primary',
      dangerLevel: 'safe',
      handler: {
        target: 'daemon',
      },
    }).success).toBe(false);

    expect(ExtensionContributionV2Schema.safeParse({
      kind: 'action',
      id: 'acme.extension.refresh',
      title: 'Refresh Acme',
      scopes: ['settings'],
      surfaces: ['settings'],
      placement: 'primary',
      dangerLevel: 'safe',
      handler: {
        target: 'daemon',
        registrationId: 'refresh',
      },
    }).success).toBe(true);
  });

  it('accepts plugin-scoped hook contributions used by reload lifecycle hooks', () => {
    const parsed = ExtensionContributionV2Schema.parse({
      kind: 'hook',
      hookApiVersion: 1,
      id: 'plugin.reload.after',
      category: 'lifecycle',
      scope: 'plugin',
      executionKind: 'observe',
      handler: {
        target: 'plugin',
        exportName: 'afterReload',
      },
    });

    expect(parsed.kind).toBe('hook');
    expect(parsed.scope).toBe('plugin');
  });
});
