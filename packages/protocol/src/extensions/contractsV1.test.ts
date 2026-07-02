import { describe, expect, it } from 'vitest';

import {
  ActionDefinitionV1Schema,
  AttachSurfaceStaticMetadataV1Schema,
  BackendDefinitionV1Schema,
  BackendSurfaceDeclarationV1Schema,
  BackendSurfaceKindV1Schema,
  BackendSurfaceOperationCatalogV1,
  ExtensionManifestV2Schema,
  ExtensionSourceSpecV1Schema,
  ExtensionTargetsV2Schema,
  HookCategoryV1Schema,
  HookEventEnvelopeV1Schema,
  HookExecutionKindV1Schema,
  HookHandlerTargetV1Schema,
  HookRegistrationV1Schema,
  HookScopeV1Schema,
  ProviderCliRuntimeV1Schema,
  ProviderDefinitionV1Schema,
  RuntimeDescriptorV1Schema,
  SerializedActionDefinitionV1Schema,
  isSupportedBackendSurfaceOperationV1,
  readHookEventEnvelopeV1,
  readHookRegistrationV1,
} from '../index.js';
import * as protocol from '../index.js';

describe('extension and hook contract exports', () => {
  it('exports additive hook enums and extension schemas through the protocol root', () => {
    expect(typeof HookScopeV1Schema.safeParse).toBe('function');
    expect(typeof HookCategoryV1Schema.safeParse).toBe('function');
    expect(typeof HookExecutionKindV1Schema.safeParse).toBe('function');
    expect(typeof ActionDefinitionV1Schema.safeParse).toBe('function');
    expect(typeof SerializedActionDefinitionV1Schema.safeParse).toBe('function');
    expect(typeof ExtensionManifestV2Schema.safeParse).toBe('function');
    expect(typeof ProviderDefinitionV1Schema.safeParse).toBe('function');
    expect(typeof ProviderCliRuntimeV1Schema.safeParse).toBe('function');
    expect(typeof BackendDefinitionV1Schema.safeParse).toBe('function');
    expect(typeof BackendSurfaceDeclarationV1Schema.safeParse).toBe('function');
    expect(typeof AttachSurfaceStaticMetadataV1Schema.safeParse).toBe('function');
    expect(typeof BackendSurfaceKindV1Schema.safeParse).toBe('function');
    expect(typeof BackendSurfaceOperationCatalogV1).toBe('object');
    expect(typeof isSupportedBackendSurfaceOperationV1).toBe('function');
    expect(typeof RuntimeDescriptorV1Schema.safeParse).toBe('function');
    expect(typeof HookRegistrationV1Schema.safeParse).toBe('function');
    expect(typeof HookEventEnvelopeV1Schema.safeParse).toBe('function');
    expect(typeof ExtensionSourceSpecV1Schema.safeParse).toBe('function');
  });

  it('parses representative extension definitions and manifests', () => {
    const actionDefinition = ActionDefinitionV1Schema.parse({
      kindVersion: 1,
      id: 'acme.plugin.review.start',
      title: 'Plugin Review',
      description: 'Runs a plugin-defined review action',
      safety: 'safe',
      placements: [],
      slash: null,
      futureActionDefinitionFlag: 'action-definition-extra',
      bindings: {
        mcpToolName: 'acme_plugin_review_start',
        futureBindingsFlag: 'bindings-extra',
      },
      examples: null,
      surfaces: {
        ui: false,
        voice: false,
        session_agent: true,
        mcp: true,
        cli: true,
        rpc: false,
        sdk: false,
        futureSurfaceFlag: 'surface-extra',
      },
      prompting: {
        voiceHotPath: true,
        futurePromptingFlag: 'prompting-extra',
      },
      inputHints: {
        title: 'Plugin Review',
        description: 'Runs a plugin-defined review action',
        futureInputHintsFlag: 'input-hints-extra',
        fields: [
          {
            path: 'instructions',
            title: 'Instructions',
            widget: 'text',
            futureFieldHintFlag: 'field-extra',
            options: [
              {
                value: 'default',
                label: 'Default',
                futureOptionFlag: 'option-extra',
              },
            ],
          },
        ],
      },
      inputSchema: {
        type: 'object',
        properties: {
          instructions: { type: 'string' },
        },
      },
    });

    const providerDefinition = ProviderDefinitionV1Schema.parse({
      kindVersion: 1,
      id: 'ohMyPi',
      providerAgentId: ' claude ',
      iconAgentId: ' codex ',
      display: {
        name: 'Oh My Pi',
        tags: ['acp'],
      },
      providerCliRuntime: {
        kindVersion: 1,
        id: 'ohMyPi',
        title: 'oh-my-pi CLI',
        binaryName: 'omp',
        sourcePreferenceDefault: 'system-first',
        managedInstall: null,
        manualInstallKind: 'vendor_recipe',
        manualInstallRecipes: null,
        acceptsJavaScriptFileOverride: true,
      },
      session: {
        storage: 'file_transcript',
        terminalRuntime: {
          supported: true,
        },
      },
      ownedBackendIds: ['ohMyPi.acp'],
    });

    const backendDefinition = BackendDefinitionV1Schema.parse({
      kindVersion: 1,
      id: 'ohMyPi.acp',
      providerId: 'ohMyPi',
      runtimeKind: 'acp',
      providerAgentId: ' claude ',
      iconAgentId: ' codex ',
      capabilities: {
        externalSessions: true,
        terminalRuntime: true,
      },
      surfaceHandlers: [
        {
          surfaceApiVersion: 1,
          id: 'backend.terminalRuntime.launch',
          kind: 'terminalRuntime',
          operation: 'launch',
          handler: {
            target: 'daemon',
            exportName: 'launch',
          },
        },
      ],
    });

    const registration = HookRegistrationV1Schema.parse({
      hookApiVersion: 1,
      id: 'backend.terminalRuntime.resolveTranscriptBinding',
      category: 'integration',
      scope: 'backend',
      executionKind: 'integrate',
      handler: {
        target: 'plugin',
        exportName: 'resolveTranscriptBinding',
      },
    });

    const manifest = ExtensionManifestV2Schema.parse({
      schemaVersion: 2,
      id: 'acme.ohmypi',
      version: '1.0.0',
      displayName: 'Acme Oh My Pi',
      description: 'Adds Oh My Pi backend support',
      engines: {
        happier: '^1.0.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['providers', 'backends', 'hooks'],
      },
      targets: {
        daemon: {
          entry: './daemon.js',
        },
      },
      contributions: [
        {
          kind: 'provider',
          ...providerDefinition,
        },
        {
          kind: 'backend',
          kindVersion: backendDefinition.kindVersion,
          id: backendDefinition.id,
          providerId: backendDefinition.providerId,
          providerAgentId: backendDefinition.providerAgentId,
          iconAgentId: backendDefinition.iconAgentId,
          engine: {
            kind: 'acp',
            transport: {
              kind: 'stdio',
              launch: {
                kind: 'executable',
                command: 'ohmypi',
                args: ['acp'],
              },
            },
            ux: {
              title: 'Oh My Pi',
            },
          },
          capabilities: backendDefinition.capabilities,
          surfaceHandlers: backendDefinition.surfaceHandlers,
        },
        {
          kind: 'hook',
          ...registration,
        },
      ],
    });

    const envelope = HookEventEnvelopeV1Schema.parse({
      eventId: 'session.started',
      scope: 'session',
      category: 'lifecycle',
      timestampMs: 1,
      happySessionId: 'session_123',
      payload: {
        status: 'started',
      },
    });

    const source = ExtensionSourceSpecV1Schema.parse({
      kind: 'path',
      locator: '/tmp/plugins/ohmypi',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    });

    expect(actionDefinition.id).toBe('acme.plugin.review.start');
    expect(providerDefinition.id).toBe('ohMyPi');
    expect(providerDefinition.providerAgentId).toBe('claude');
    expect(providerDefinition.iconAgentId).toBe('codex');
    expect(providerDefinition.providerCliRuntime?.binaryName).toBe('omp');
    expect(backendDefinition.id).toBe('ohMyPi.acp');
    expect(backendDefinition.providerAgentId).toBe('claude');
    expect(backendDefinition.iconAgentId).toBe('codex');
    expect(backendDefinition.surfaceHandlers).toHaveLength(1);
    expect(backendDefinition.surfaceHandlers[0]).toMatchObject({
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
      operation: 'launch',
    });
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.contributions).toHaveLength(3);
    expect(manifest.contributions[0]).toMatchObject({
      kind: 'provider',
      id: 'ohMyPi',
      providerAgentId: 'claude',
      iconAgentId: 'codex',
    });
    expect(manifest.contributions[1]).toMatchObject({
      kind: 'backend',
      id: 'ohMyPi.acp',
    });
    expect(manifest.contributions[2]).toMatchObject({
      kind: 'hook',
      id: 'backend.terminalRuntime.resolveTranscriptBinding',
    });
    expect(registration.id).toBe('backend.terminalRuntime.resolveTranscriptBinding');
    expect(manifest.targets.daemon?.entry).toBe('./daemon.js');
    expect(envelope.scope).toBe('session');
    expect(source.kind).toBe('path');
  });

  it('rejects hook registrations when category and execution semantics conflict', () => {
    const parsed = HookRegistrationV1Schema.safeParse({
      hookApiVersion: 1,
      id: 'backend.terminalRuntime.resolveTranscriptBinding',
      category: 'integration',
      scope: 'backend',
      executionKind: 'observe',
      handler: {
        target: 'daemon',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects hook registrations whose handler target is not a plugin export', () => {
    const parsed = HookRegistrationV1Schema.safeParse({
      hookApiVersion: 1,
      id: 'backend.terminalRuntime.resolveTranscriptBinding',
      category: 'integration',
      scope: 'backend',
      executionKind: 'integrate',
      handler: {
        target: 'daemon',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts only plugin hook handler targets in the supported v1 contract', () => {
    expect(HookHandlerTargetV1Schema.parse('plugin')).toBe('plugin');
    expect(HookHandlerTargetV1Schema.safeParse('daemon').success).toBe(false);
  });

  it('rejects invalid backend surface descriptors', () => {
    const parsed = BackendDefinitionV1Schema.safeParse({
      kindVersion: 1,
      id: 'ohMyPi.acp',
      providerId: 'ohMyPi',
      runtimeKind: 'acp',
      capabilities: {},
      surfaceHandlers: [
        {
          surfaceApiVersion: 1,
          id: 'backend.terminalRuntime.launch',
          kind: 'terminalRuntime',
          operation: 'launch',
          handler: {
            target: 'daemon',
            exportName: '',
          },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('requires canonical backend surface operations instead of deriving them from opaque ids', () => {
    expect(BackendSurfaceDeclarationV1Schema.safeParse({
      surfaceApiVersion: 1,
      id: 'launch-adapter',
      kind: 'terminalRuntime',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    }).success).toBe(false);

    const parsed = BackendSurfaceDeclarationV1Schema.parse({
      surfaceApiVersion: 1,
      id: 'launch-adapter',
      kind: 'terminalRuntime',
      operation: 'launch',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    });

    expect(parsed).toMatchObject({
      id: 'launch-adapter',
      kind: 'terminalRuntime',
      operation: 'launch',
    });
  });

  it('treats backend surface operation names as host-validated ABI strings rather than schema-level enums', () => {
    const parsed = BackendSurfaceDeclarationV1Schema.parse({
      surfaceApiVersion: 1,
      id: 'future-adapter',
      kind: 'terminalRuntime',
      operation: 'futureOperation',
      handler: {
        target: 'daemon',
        exportName: 'futureOperation',
      },
    });

    expect(parsed.operation).toBe('futureOperation');
    expect(isSupportedBackendSurfaceOperationV1({
      kind: 'terminalRuntime',
      operation: 'launch',
    })).toBe(true);
    expect(isSupportedBackendSurfaceOperationV1({
      kind: 'terminalRuntime',
      operation: 'futureOperation',
    })).toBe(false);
  });

  it('accepts the final six backend surface kinds and rejects stale surface-kind names', () => {
    expect(BackendSurfaceKindV1Schema.options).toEqual([
      'terminalRuntime',
      'externalSession',
      'attach',
      'handoff',
      'fork',
      'checkpoint',
    ]);
    expect(BackendSurfaceKindV1Schema.safeParse('externalSessions').success).toBe(false);
    expect(BackendSurfaceKindV1Schema.safeParse('sessionHandoff').success).toBe(false);
  });

  it('uses final backend surface operation vocabulary', () => {
    expect(BackendSurfaceOperationCatalogV1.terminalRuntime.resolveTranscriptBinding).toBe('resolveTranscriptBinding');
    expect(BackendSurfaceOperationCatalogV1.externalSession.resolveSource).toBe('resolveSource');
    expect(BackendSurfaceOperationCatalogV1.externalSession.resolveTakeoverLaunch).toBe('resolveTakeoverLaunch');
    expect(BackendSurfaceOperationCatalogV1.attach.evaluateAvailability).toBe('evaluateAvailability');
    expect(BackendSurfaceOperationCatalogV1.attach.attach).toBe('attach');
    expect(BackendSurfaceOperationCatalogV1.handoff.exportBundle).toBe('exportBundle');
    expect(BackendSurfaceOperationCatalogV1.fork.resolveReplayChildLaunch).toBe('resolveReplayChildLaunch');
    expect(BackendSurfaceOperationCatalogV1.checkpoint.restore).toBe('restore');
    expect((BackendSurfaceOperationCatalogV1.terminalRuntime as Record<string, unknown>).bindTranscript).toBeUndefined();
  });

  it('keeps attach backend surface static metadata display-only', () => {
    expect(BackendSurfaceDeclarationV1Schema.safeParse({
      surfaceApiVersion: 1,
      id: 'backend.attach.tmux',
      kind: 'attach',
      operation: 'attach',
      handler: {
        target: 'daemon',
        exportName: 'attach',
      },
      staticMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        maxClients: 1,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }).success).toBe(true);
    expect(BackendSurfaceDeclarationV1Schema.safeParse({
      surfaceApiVersion: 1,
      id: 'backend.attach.provider',
      kind: 'attach',
      operation: 'attach',
      handler: {
        target: 'daemon',
        exportName: 'attach',
      },
      staticMetadata: {
        attachStrategy: 'provider_attach',
        topology: 'shared',
        remoteWritable: true,
      },
    }).success).toBe(false);
    expect(BackendSurfaceDeclarationV1Schema.safeParse({
      surfaceApiVersion: 1,
      id: 'backend.attach.terminal',
      kind: 'attach',
      operation: 'attach',
      handler: {
        target: 'daemon',
        exportName: 'attach',
      },
      staticMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        injectUserPrompt: true,
      },
    }).success).toBe(false);
  });

  it('rejects stale runtime adapter carriers in final backend definitions', () => {
    const parsed = BackendDefinitionV1Schema.safeParse({
      kindVersion: 1,
      id: 'ohMyPi.acp',
      providerId: 'ohMyPi',
      runtimeKind: 'acp',
      capabilities: {},
      runtimeAdapters: [],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects unsupported extension target descriptors in the v2 manifest contract', () => {
    expect(
      ExtensionTargetsV2Schema.safeParse({
        daemon: {
          entry: './daemon.js',
        },
        uiDescriptor: {
          entry: './ui.js',
        },
      }).success,
    ).toBe(false);

    expect(
      ExtensionTargetsV2Schema.safeParse({
        daemon: {
          entry: './daemon.js',
        },
        serverDescriptor: {
          entry: './server.js',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects plugin-target backend surface handlers in the v1 contract', () => {
    const parsed = BackendSurfaceDeclarationV1Schema.safeParse({
      surfaceApiVersion: 1,
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
      operation: 'launch',
      handler: {
        target: 'plugin',
        exportName: 'launch',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('does not expose stale runtime adapter helpers through the public protocol root', () => {
    expect((protocol as Record<string, unknown>).BackendRuntimeAdapterOperationCatalogV1).toBeUndefined();
    expect((protocol as Record<string, unknown>).BackendRuntimeAdapterV1Schema).toBeUndefined();
    expect((protocol as Record<string, unknown>).BackendRuntimeAdapterOperationIdsByKindV1).toBeUndefined();
    expect((protocol as Record<string, unknown>).isSupportedBackendRuntimeAdapterOperationIdV1).toBeUndefined();
  });

  it('rejects invalid provider CLI runtime descriptors in provider definitions', () => {
    const parsed = ProviderDefinitionV1Schema.safeParse({
      kindVersion: 1,
      id: 'acme.plugin',
      display: {
        name: 'Acme Plugin',
        tags: ['plugin'],
      },
      providerCliRuntime: {
        kindVersion: 1,
        id: 'acme.plugin',
        title: 'Acme Plugin CLI',
        binaryName: 'acme-plugin',
        sourcePreferenceDefault: 'invalid',
        managedInstall: null,
        manualInstallKind: 'command',
        manualInstallRecipes: null,
        acceptsJavaScriptFileOverride: false,
      },
      ownedBackendIds: ['acme.plugin.backend'],
    });

    expect(parsed.success).toBe(false);
  });

  it('reads hook registrations from additive mixed-version payloads', () => {
    expect(typeof readHookRegistrationV1).toBe('function');

    const normalized = readHookRegistrationV1({
      hookApiVersion: 1,
      id: 'session.started',
      category: 'lifecycle',
      scope: 'session',
      handler: {
        target: 'plugin',
      },
    }) as { executionKind: string } | null;

    expect(normalized).toBeTruthy();
    expect(normalized?.executionKind).toBe('observe');

    const unsupportedVersion = readHookRegistrationV1({
      hookApiVersion: 2,
      id: 'session.started',
      category: 'lifecycle',
      scope: 'session',
      executionKind: 'observe',
      handler: {
        target: 'plugin',
      },
    });
    expect(unsupportedVersion).toBe(null);
  });

  it('reads hook event envelopes from additive mixed-version payload aliases', () => {
    expect(typeof readHookEventEnvelopeV1).toBe('function');

    const normalized = readHookEventEnvelopeV1({
      hookVersion: 1,
      hookEventId: 'session.started',
      category: 'lifecycle',
      scope: 'session',
      timestampMs: 1,
      payload: {},
    }) as { eventId: string } | null;

    expect(normalized).toBeTruthy();
    expect(normalized?.eventId).toBe('session.started');

    const legacyProviderSession = readHookEventEnvelopeV1({
      hookVersion: 1,
      eventId: 'session.started',
      category: 'lifecycle',
      scope: 'session',
      timestampMs: 1,
      vendorSessionId: 'legacy-provider-session',
      payload: {},
    }) as { providerSessionId?: string; vendorSessionId?: string } | null;

    expect(legacyProviderSession).toBeTruthy();
    expect(legacyProviderSession?.providerSessionId).toBe('legacy-provider-session');
    expect(legacyProviderSession?.vendorSessionId).toBeUndefined();

    const invalid = readHookEventEnvelopeV1({
      hookVersion: 1,
      category: 'lifecycle',
      scope: 'session',
      timestampMs: 1,
      payload: {},
    });
    expect(invalid).toBe(null);

    const conflicting = readHookEventEnvelopeV1({
      hookVersion: 1,
      eventId: 'session.started',
      hookEventId: 'session.ended',
      category: 'lifecycle',
      scope: 'session',
      timestampMs: 1,
      payload: {},
    });
    expect(conflicting).toBe(null);

    const unsupportedVersion = readHookEventEnvelopeV1({
      hookVersion: 2,
      eventId: 'session.started',
      category: 'lifecycle',
      scope: 'session',
      timestampMs: 1,
      payload: {},
    });
    expect(unsupportedVersion).toBe(null);
  });

  it('accepts widened hook scopes for daemon and plugin lifecycle events', () => {
    const registration = HookRegistrationV1Schema.parse({
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

    const envelope = HookEventEnvelopeV1Schema.parse({
      hookVersion: 1,
      eventId: 'spawn.augmentEnv',
      category: 'augmentation',
      scope: 'daemon',
      timestampMs: 1,
      payload: {},
    });

    expect(registration.scope).toBe('plugin');
    expect(envelope.scope).toBe('daemon');
  });

  it('rejects unsafe extension ids in v2 manifests', () => {
    for (const extensionId of [
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
        id: extensionId,
        version: '1.0.0',
        displayName: 'Unsafe Extension',
        description: 'Should fail validation',
        engines: {
          happier: '^1.0.0',
        },
        runtime: {
          apiVersion: 1,
          capabilities: [],
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
        },
        permissions: [],
        contributions: [],
      }).success).toBe(false);
    }
  });
});
