import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST as APP_CONTEXT_MANIFEST } from '@happier-dev/plugins-app-context/manifest';
import { readBundledPluginManifest } from '../projection/registry/builtIn/locators';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../projection/registry/sources/generatedBundledPluginManifests';

import { ingestCanonicalPluginManifest } from './ingest';
import { validatePluginManifest } from './validate';

const INCOMPATIBLE_HAPPIER_ENGINE_MESSAGE = 'Plugin manifest requires a compatible Happier CLI version';

function diagnosticMessages(result: ReturnType<typeof validatePluginManifest>): readonly string[] {
  return result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.message);
}

function createManifest(id: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    version: '1.0.0',
    displayName: `Plugin ${id}`,
    engines: { happier: '>=0.2.0 <1.0.0' }, runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.mjs' },
    hostAccess: { required: [], optional: [] },
    contributes: {},
  };
}

describe('validatePluginManifest', () => {
  it('admits the bundled App context runtime and rejects its declaration without an executable entrypoint', () => {
    const options = { manifestAuthority: 'bundled_first_party', sourceProvenance: 'localSource' } as const;
    const { entrypoints: _entrypoints, ...withoutEntrypoint } = APP_CONTEXT_MANIFEST;

    expect(validatePluginManifest(withoutEntrypoint, options)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_semantic_invalid' })],
    });
    expect(validatePluginManifest(APP_CONTEXT_MANIFEST, options)).toMatchObject({ ok: true });
    // Source daemon discovery consumes the generator's bundled projection,
    // before an ignored packaged plugin manifest or runtime exists.
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(({ pluginId }) => pluginId === APP_CONTEXT_MANIFEST.id);
    if (!locator) throw new Error('Missing bundled App context locator');
    const bundledManifest = readBundledPluginManifest(locator);
    expect(validatePluginManifest(bundledManifest, options)).toMatchObject({ ok: true });
  });

  it('accepts a client-executed Voice provider without manufacturing a daemon entrypoint', () => {
    const result = validatePluginManifest({
      schemaVersion: 2,
      id: 'acme.client-voice',
      version: '1.0.0',
      displayName: 'Client Voice',
      engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },
      hostAccess: { required: [], optional: [] },
      contributes: {
        voiceProviders: [{
          id: 'conversation',
          title: 'Conversation',
          kind: 'conversation',
          roles: ['realtime_conversation'],
          platforms: ['web'],
          capabilities: {
            turn: { cancelResponse: true, bargeIn: false },
          },
          client: {
            artifactId: 'voice-runtime-web',
            exportName: 'activate',
          },
        }],
      },
    }, { sourceProvenance: 'registryCustodied' });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });

  it('keeps RecipientOperationV1 authority independent from retired action linkage', () => {
    const manifest = {
      schemaVersion: 2,
      id: 'acme.credential-voice',
      version: '1.0.0',
      displayName: 'Credential Voice',
      engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' },
      hostAccess: {
        required: [{
          id: 'voice-session-api',
          capability: 'network',
          reason: 'Mint a short-lived Voice session artifact',
          scope: {
            targets: [{ kind: 'fixedOrigin', origin: 'https://voice.example.test' }],
            methods: ['POST'],
          },
        }, {
          id: 'voice-catalog-api',
          capability: 'network',
          reason: 'Read the bounded Voice catalog',
          scope: {
            targets: [{ kind: 'fixedOrigin', origin: 'https://voice.example.test' }],
            methods: ['GET'],
          },
        }],
        optional: [],
      },
      contributes: {
        actions: [{
          id: 'mint-session',
          title: 'Mint session',
          scopes: ['global'],
          surfaces: ['ui'],
          execution: { target: 'daemon' },
          placementBindings: ['detailsPanel'],
          dangerLevel: 'safe',
          hostAccess: ['voice-session-api'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
          },
          resultSchema: {
            type: 'object',
            properties: {
              kind: { const: 'bearer_token' },
              value: { type: 'string', minLength: 1 },
              expiresAtMs: { type: 'number' },
              placement: { const: 'authorization_header' },
            },
            required: ['kind', 'value', 'expiresAtMs', 'placement'],
            additionalProperties: false,
          },
        }, {
          id: 'list-voices',
          title: 'List voices',
          scopes: ['global'],
          surfaces: ['ui'],
          execution: { target: 'daemon' },
          placementBindings: ['detailsPanel'],
          dangerLevel: 'safe',
          hostAccess: ['voice-catalog-api'],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
          },
          resultSchema: {
            oneOf: [{
              type: 'object',
              properties: {
                ok: { const: true },
                items: {
                  type: 'array',
                  maxItems: 500,
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', minLength: 1, maxLength: 256 },
                      name: { type: 'string', minLength: 1, maxLength: 256 },
                      metadata: {
                        type: 'object',
                        additionalProperties: {
                          oneOf: [
                            { type: 'string', maxLength: 512 },
                            { type: 'number' },
                            { type: 'boolean' },
                            { type: 'null' },
                          ],
                        },
                      },
                    },
                    required: ['id', 'name'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['ok', 'items'],
              additionalProperties: false,
            }, {
              type: 'object',
              properties: {
                ok: { const: false },
                errorCode: {
                  enum: [
                    'invalid_parameters',
                    'credential_unavailable',
                    'provider_unavailable',
                    'operation_unsupported',
                    'rate_limited',
                    'request_timeout',
                    'cancelled',
                    'provider_response_invalid',
                    'internal_error',
                  ],
                },
                error: {
                  enum: [
                    'invalid_parameters',
                    'credential_unavailable',
                    'provider_unavailable',
                    'operation_unsupported',
                    'rate_limited',
                    'request_timeout',
                    'cancelled',
                    'provider_response_invalid',
                    'internal_error',
                  ],
                },
                retryable: { type: 'boolean' },
              },
              required: ['ok', 'errorCode', 'error', 'retryable'],
              additionalProperties: false,
            }],
          },
        }],
        voiceProviders: [{
          id: 'conversation',
          title: 'Conversation',
          kind: 'conversation',
          roles: ['realtime_conversation'],
          platforms: ['web'],
          capabilities: {
            turn: { cancelResponse: true, bargeIn: false },
          },
          credentials: {
            slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
            requirement: { kind: 'always' },
            sources: [{
              kind: 'savedSecret',
              secretKinds: ['apiKey'],
              operationProjections: [{
                kind: 'recipientCredential', operation: 'client-auth', phase: 'prepare', format: 'bearer',
              }, {
                kind: 'recipientCredential', operation: 'list-voices', phase: 'prepare', format: 'bearer',
              }],
            }],
            hostMediated: { operations: [{
                id: 'client-auth',
                purpose: 'voice.client-auth',
                credentialSlotId: 'api_key',
                effect: 'read',
                request: {
                  origin: 'https://voice.example.test',
                  pathTemplate: '/v1/session',
                  queryTemplate: [],
                  headerTemplate: [],
                  bodyTemplate: { kind: 'none' },
                  method: 'POST',
                  credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
                  redirect: 'error',
                  maxBodyBytes: 0,
                  contentTypes: [],
                },
                parameters: {
                  schema: { type: 'object', properties: {}, additionalProperties: false },
                  mapping: [],
                },
                response: { maxBytes: 32 * 1024, contentTypes: ['application/json'] },
              }, {
                id: 'list-voices',
                purpose: 'voice.catalog.voices',
                credentialSlotId: 'api_key',
                effect: 'read',
                request: {
                  origin: 'https://voice.example.test',
                  pathTemplate: '/v1/voices',
                  queryTemplate: [],
                  headerTemplate: [],
                  bodyTemplate: { kind: 'none' },
                  method: 'GET',
                  credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
                  redirect: 'error',
                  maxBodyBytes: 0,
                  contentTypes: [],
                },
                parameters: {
                  schema: { type: 'object', properties: {}, additionalProperties: false },
                  mapping: [],
                },
                response: { maxBytes: 2 * 1024 * 1024, contentTypes: ['application/json'] },
              }] },
          },
          client: {
            artifactId: 'voice-runtime-web',
            exportName: 'activate',
          },
        }],
      },
    };

    expect(validatePluginManifest(manifest, { sourceProvenance: 'registryCustodied' })).toEqual(expect.objectContaining({ ok: true }));
    expect(validatePluginManifest({
      ...manifest,
      contributes: {
        ...manifest.contributes,
        actions: manifest.contributes.actions.map((action) => (
          action.id === 'mint-session' ? { ...action, id: 'other-action' } : action
        )),
      },
    }, { sourceProvenance: 'registryCustodied' })).toEqual(expect.objectContaining({ ok: true }));
    const unsafeAction = validatePluginManifest({
      ...manifest,
      contributes: {
        ...manifest.contributes,
        actions: manifest.contributes.actions.map((action) => (
          action.id === 'mint-session'
            ? {
                ...action,
                dangerLevel: 'writesRemote',
                confirmation: {
                  title: 'Mint Voice session',
                },
              }
            : action
        )),
      },
    }, { sourceProvenance: 'registryCustodied' });
    expect(unsafeAction).toEqual(expect.objectContaining({ ok: true }));
    const broadCatalogAccess = validatePluginManifest({
      ...manifest,
      hostAccess: {
        ...manifest.hostAccess,
        required: manifest.hostAccess.required.map((request) => (
          request.id === 'voice-catalog-api'
            ? {
                ...request,
                scope: {
                  targets: [
                    ...request.scope.targets,
                    { kind: 'fixedOrigin', origin: 'https://other.example.test' },
                  ],
                  methods: ['GET', 'POST'],
                },
              }
            : request
        )),
      },
    }, { sourceProvenance: 'registryCustodied' });
    expect(broadCatalogAccess).toEqual(expect.objectContaining({ ok: true }));
  });

  it.each([
    ['action', {
      actions: [{
        id: 'run',
        title: 'Run',
        scopes: ['global'],
        surfaces: ['cli'],
        execution: { target: 'daemon' },
        placementBindings: ['commandPalette'],
        dangerLevel: 'safe',
      }],
    }],
    ['custom Agent', {
      agents: [{
        id: 'agent',
        title: 'Agent',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
          sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
        },
      }],
    }],
    ['dynamic MCP server', {
      mcp: {
        servers: [{ id: 'dynamic-server', title: 'Dynamic server', kind: 'dynamic' }],
        discoverySources: [],
      },
    }],
  ])('requires a daemon or development entrypoint for a %s registration', (_family, contributes) => {
    const result = validatePluginManifest({
      schemaVersion: 2,
      id: `acme.${String(_family).toLowerCase().replaceAll(' ', '-')}`,
      version: '1.0.0',
      displayName: String(_family),
      engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },
      hostAccess: { required: [], optional: [] },
      contributes,
    }, { sourceProvenance: 'registryCustodied' });

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringContaining('daemon or development entrypoint'),
      })],
    });
  });

  it('admits the current custom Agent declaration and refuses retired surface handlers', () => {
    const agent = {
      id: 'agent',
      title: 'Agent',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
      },
    };
    const current = createManifest('acme.current-agent');
    current.contributes = { agents: [agent] };
    expect(validatePluginManifest(current, { sourceProvenance: 'registryCustodied' })).toEqual(expect.objectContaining({ ok: true }));

    const retired = createManifest('acme.retired-surface');
    retired.contributes = {
      agents: [{
        ...agent,
        surfaceHandlers: [{
          surfaceApiVersion: 1,
          id: 'checkpoint-restore',
          kind: 'checkpoint',
          operation: 'restore',
          support: 'conditional',
        }],
      }],
    };
    const result = validatePluginManifest(retired, { sourceProvenance: 'registryCustodied' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_manifest_invalid',
          message: expect.stringContaining('contributes.agents.0'),
        }),
      ]);
    }
  });

  it('scopes the reserved happier namespace to registry-custodied artifacts', () => {
    // The rule stops a *published* artifact from impersonating a first-party
    // plugin. A working tree on this machine is the maintainer's own dev loop:
    // there is nothing to impersonate, and blocking it blocks developing the
    // plugins this repository ships.
    expect(validatePluginManifest(createManifest('happier.agent.fake'), {
      sourceProvenance: 'localSource',
    })).toEqual(expect.objectContaining({ ok: true }));

    expect(validatePluginManifest(createManifest('happier.agent.fake'), {
      sourceProvenance: 'registryCustodied',
    })).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringContaining('reserved happier.* namespace'),
      })],
    });
  });

  it('enforces a declared engine range for local, registry and bundled sources', () => {
    const unsatisfiable = createManifest('acme.future-host');
    unsatisfiable.engines = { happier: '>=9999.0.0' };

    for (const options of [
      { sourceProvenance: 'localSource' },
      { sourceProvenance: 'registryCustodied' },
      { sourceProvenance: 'localSource', manifestAuthority: 'bundled_first_party' },
    ] as const) {
      expect(validatePluginManifest(unsatisfiable, options)).toMatchObject({ ok: false,
        diagnostics: [{ code: 'plugin_manifest_engine_incompatible', message: INCOMPATIBLE_HAPPIER_ENGINE_MESSAGE }] });
    }
  });

  it('keeps every provenance-independent semantic rule enforced for a local source', () => {
    const unsupportedEntry = createManifest('happier.agent.local-dev');
    unsupportedEntry.entrypoints = { daemon: './daemon.unsupported' };

    expect(diagnosticMessages(validatePluginManifest(unsupportedEntry, {
      sourceProvenance: 'localSource',
    }))).toEqual(['Plugin daemon entry uses an unsupported extension']);
  });

  it('accepts full npm semver ranges for engines.happier', () => {
    const manifest = createManifest('acme.semver');
    manifest.engines = { happier: '~0.2.0 || >=0.3.0 <1.0.0' };

    expect(validatePluginManifest(manifest, { sourceProvenance: 'registryCustodied' })).toEqual(expect.objectContaining({ ok: true }));
  });

  it('does not synthesize a host-version floor when engines.happier is absent', () => {
    const manifest = createManifest('acme.no-engine-floor');
    delete manifest.engines;

    expect(validatePluginManifest(manifest, { sourceProvenance: 'registryCustodied' })).toEqual(expect.objectContaining({ ok: true }));
  });

  it('keeps an unsupported daemon entry diagnostic bounded without echoing the declared path', () => {
    const daemonEntry = `./${'x'.repeat(40 * 1024)}.unsupported`;
    const manifest = createManifest('acme.long-daemon-entry');
    manifest.entrypoints = { daemon: daemonEntry };

    const result = validatePluginManifest(manifest, { sourceProvenance: 'registryCustodied' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = result.diagnostics.find((entry) => (
        entry.code === 'plugin_manifest_semantic_invalid'
      ));
      expect(diagnostic?.message).toBe('Plugin daemon entry uses an unsupported extension');
      expect(diagnostic?.message).not.toContain(daemonEntry);
      expect(diagnostic?.message.length).toBeLessThanOrEqual(32_768);
    }
  });

  it('keeps a long valid incompatible engines.happier diagnostic bounded without echoing the declared range', () => {
    const happierEngine = `>=9999.0.0${' '.repeat(37_976)}<10000.0.0`;
    const manifest = createManifest('acme.long-happier-engine');
    manifest.engines = { happier: happierEngine };

    const result = validatePluginManifest(manifest, { sourceProvenance: 'registryCustodied' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = result.diagnostics.find((entry) => (
        entry.code === 'plugin_manifest_engine_incompatible'
      ));
      expect(diagnostic?.message).toBe('Plugin manifest requires a compatible Happier CLI version');
      expect(diagnostic?.message).not.toContain(happierEngine);
      expect(diagnostic?.message.length).toBeLessThanOrEqual(32_768);
    }
  });

  it('reports a named syntax diagnostic for invalid engines.happier ranges', () => {
    const manifest = createManifest('acme.invalid-semver');
    manifest.engines = { happier: 'not a semver range' };

    const result = validatePluginManifest(manifest, { sourceProvenance: 'registryCustodied' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_manifest_invalid',
          message: expect.stringContaining('engines.happier'),
        }),
      ]);
    }
  });

  it('reports the failing JSON path for nested manifest schema errors', () => {
    const manifest = createManifest('acme.invalid-action-surfaces');
    manifest.contributes = {
      actions: [
        {
          id: 'list',
          title: 'List notes',
          scopes: ['global'],
          surfaces: 'cli',
          execution: { target: 'daemon' },
          placementBindings: ['commandPalette'],
          dangerLevel: 'safe',
        },
      ],
    };

    const result = validatePluginManifest(manifest, { sourceProvenance: 'registryCustodied' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_manifest_invalid',
          message: expect.stringContaining('contributes.actions.0.surfaces:'),
        }),
      ]);
    }
  });

  it('shares ACP system-tool reference resolution with canonical manifest ingestion', () => {
    const manifest = createManifest('acme.undeclared-acp-tool');
    manifest.contributes = {
      agents: [{
        id: 'agent',
        title: 'Agent',
        runtime: {
          kind: 'acp',
          transport: {
            kind: 'stdio',
            executable: { kind: 'systemTool', id: 'missing-tool' },
          },
        },
        primary: 'sessions',
        capabilities: {
          sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
        },
      }],
    };

    expect(validatePluginManifest(manifest, { sourceProvenance: 'registryCustodied' })).toMatchObject({ ok: false,
      diagnostics: [{ code: 'plugin_manifest_invalid', message: expect.stringContaining('runtime.transport.executable.id') }] });
    expect(ingestCanonicalPluginManifest(manifest, { sourceProvenance: 'registryCustodied' })).toEqual({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({
        code: 'plugin_manifest_dangling_reference',
        message: expect.stringContaining('missing-tool'),
      })]),
    });
  });
});
