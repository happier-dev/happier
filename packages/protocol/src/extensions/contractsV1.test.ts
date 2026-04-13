import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('extension and hook contract exports', () => {
  it('exports additive hook enums and extension schemas through the protocol root', () => {
    expect(typeof (protocol as any).HookScopeV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).HookCategoryV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).HookExecutionKindV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).ActionDefinitionV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).SerializedActionDefinitionV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).PluginManifestV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).ProviderDefinitionV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).ProviderCliRuntimeV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).BackendDefinitionV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).HookRegistrationV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).HookEventEnvelopeV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).ExtensionSourceSpecV1Schema?.safeParse).toBe('function');
  });

  it('parses representative extension definitions and manifests', () => {
    const actionDefinition = (protocol as any).ActionDefinitionV1Schema.parse({
      kindVersion: 1,
      id: 'acme.plugin.review.start',
      title: 'Plugin Review',
      description: 'Runs a plugin-defined review action',
      safety: 'safe',
      placements: [],
      slash: null,
      bindings: {
        mcpToolName: 'acme_plugin_review_start',
      },
      examples: null,
      surfaces: {
        ui_button: false,
        ui_slash_command: false,
        voice_tool: false,
        voice_action_block: false,
        session_agent: true,
        mcp: true,
        cli: true,
      },
      inputHints: null,
      inputSchema: {
        type: 'object',
        properties: {
          instructions: { type: 'string' },
        },
      },
    });

    const providerDefinition = (protocol as any).ProviderDefinitionV1Schema.parse({
      kindVersion: 1,
      id: 'ohMyPi',
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

    const backendDefinition = (protocol as any).BackendDefinitionV1Schema.parse({
      kindVersion: 1,
      id: 'ohMyPi.acp',
      providerId: 'ohMyPi',
      runtimeKind: 'acp',
      capabilities: {
        directSessions: true,
        terminalRuntime: true,
      },
      runtimeAdapters: [
        {
          runtimeAdapterApiVersion: 1,
          id: 'backend.terminalRuntime.launch',
          kind: 'terminalRuntime',
          handler: {
            target: 'daemon',
            exportName: 'launch',
          },
        },
      ],
    });

    const registration = (protocol as any).HookRegistrationV1Schema.parse({
      hookApiVersion: 1,
      id: 'backend.terminalRuntime.bindTranscript',
      category: 'integration',
      scope: 'backend',
      executionKind: 'integrate',
      handler: {
        target: 'plugin',
        exportName: 'bindTranscript',
      },
    });

    const manifest = (protocol as any).PluginManifestV1Schema.parse({
      schemaVersion: 1,
      id: 'acme.ohmypi',
      version: '1.0.0',
      displayName: 'Acme Oh My Pi',
      description: 'Adds Oh My Pi backend support',
      engines: {
        happier: '^1.0.0',
      },
      targets: {
        daemon: {
          entry: './daemon.js',
        },
      },
      contributions: {
        providers: [providerDefinition],
        backends: [backendDefinition],
        hooks: [registration],
      },
    });

    const envelope = (protocol as any).HookEventEnvelopeV1Schema.parse({
      eventId: 'session.started',
      scope: 'session',
      category: 'lifecycle',
      timestampMs: 1,
      happySessionId: 'session_123',
      payload: {
        status: 'started',
      },
    });

    const source = (protocol as any).ExtensionSourceSpecV1Schema.parse({
      kind: 'path',
      locator: '/tmp/plugins/ohmypi',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    });

    expect(actionDefinition.id).toBe('acme.plugin.review.start');
    expect(providerDefinition.id).toBe('ohMyPi');
    expect(providerDefinition.providerCliRuntime?.binaryName).toBe('omp');
    expect(backendDefinition.id).toBe('ohMyPi.acp');
    expect(backendDefinition.runtimeAdapters).toHaveLength(1);
    expect(backendDefinition.runtimeAdapters[0]).toMatchObject({
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
    });
    expect(registration.id).toBe('backend.terminalRuntime.bindTranscript');
    expect(manifest.contributions.providers).toHaveLength(1);
    expect(manifest.contributions.backends[0].runtimeAdapters).toHaveLength(1);
    expect(envelope.scope).toBe('session');
    expect(source.kind).toBe('path');
  });

  it('rejects hook registrations when category and execution semantics conflict', () => {
    const parsed = (protocol as any).HookRegistrationV1Schema.safeParse({
      hookApiVersion: 1,
      id: 'backend.terminalRuntime.bindTranscript',
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
    const parsed = (protocol as any).HookRegistrationV1Schema.safeParse({
      hookApiVersion: 1,
      id: 'backend.terminalRuntime.bindTranscript',
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
    expect((protocol as any).HookHandlerTargetV1Schema.parse('plugin')).toBe('plugin');
    expect((protocol as any).HookHandlerTargetV1Schema.safeParse('daemon').success).toBe(false);
  });

  it('rejects invalid backend runtime adapter descriptors', () => {
    const parsed = (protocol as any).BackendDefinitionV1Schema.safeParse({
      kindVersion: 1,
      id: 'ohMyPi.acp',
      providerId: 'ohMyPi',
      runtimeKind: 'acp',
      capabilities: {},
      runtimeAdapters: [
        {
          runtimeAdapterApiVersion: 1,
          id: 'backend.terminalRuntime.launch',
          kind: 'terminalRuntime',
          handler: {
            target: 'daemon',
            exportName: '',
          },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects unsupported plugin manifest target descriptors in the v1 contract', () => {
    expect(
      (protocol as any).PluginTargetsV1Schema.safeParse({
        daemon: {
          entry: './daemon.js',
        },
        uiDescriptor: {
          entry: './ui.js',
        },
      }).success,
    ).toBe(false);

    expect(
      (protocol as any).PluginTargetsV1Schema.safeParse({
        daemon: {
          entry: './daemon.js',
        },
        serverDescriptor: {
          entry: './server.js',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects plugin-target backend runtime adapter handlers in the v1 contract', () => {
    const parsed = (protocol as any).BackendRuntimeAdapterV1Schema.safeParse({
      runtimeAdapterApiVersion: 1,
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
      handler: {
        target: 'plugin',
        exportName: 'launch',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects invalid provider CLI runtime descriptors in provider definitions', () => {
    const parsed = (protocol as any).ProviderDefinitionV1Schema.safeParse({
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
    const readHookRegistrationV1 = (protocol as any).readHookRegistrationV1 as (value: unknown) => unknown;
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
    const readHookEventEnvelopeV1 = (protocol as any).readHookEventEnvelopeV1 as (value: unknown) => unknown;
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
});
