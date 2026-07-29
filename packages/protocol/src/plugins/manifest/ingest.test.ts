import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2, resolvePluginManifestSetReferencesV2 } from './ingest.js';
import { PLUGIN_MANIFEST_INPUT_LIMITS } from './limits.js';
import {
  PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
  PluginManifestHostAccessV2Schema,
} from './v2.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '../contributions/catalog.js';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'com.acme.fixture',
    version: '1.0.0',
    displayName: 'Fixture',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './dist/plugin.js' },
    hostAccess: { required: [], optional: [] },
    contributes: {},
    ...overrides,
  };
}

function managedDependency(id: string): Record<string, unknown> {
  return {
    id,
    title: 'Managed',
    description: 'Managed executable',
    sources: [{ kind: 'system', executableNames: [id] }],
    executable: id,
  };
}

function connectedAccountDescriptor(id: string): Record<string, unknown> {
  return {
    id,
    title: 'Account',
    authentication: {
      defaultModeId: 'manual',
      modes: [{
        id: 'manual',
        kind: 'manual',
        outcomeReconciliation: 'none',
        fields: [{
          id: 'token',
          title: 'Token',
          schema: { type: 'string' },
          secret: true,
        }],
      }],
    },
  };
}

describe('canonical plugin manifest ingestion', () => {
  it('accepts target entrypoints/hostAccess and rejects retired manifest owners', () => {
    const target = manifest({
      entrypoints: { daemon: './dist/plugin.js', development: './src/plugin.ts' },
      activation: { events: [{ kind: 'startup' }] },
      hostAccess: { required: [], optional: [] },
    });
    expect(ingestPluginManifestV2(target).ok).toBe(true);

    for (const retired of [
      { uses: [] },
      { declares: { capabilities: [] } },
      { permissions: { required: [] } },
      { source: { kind: 'path', path: '/tmp/plugin' } },
      { activationEvents: ['startup'] },
      { activation: { events: ['startup'] } },
      { entrypoints: { main: './dist/plugin.js' } },
    ]) {
      expect(ingestPluginManifestV2({ ...target, ...retired })).toEqual({
        ok: false,
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'plugin_manifest_invalid' })]),
      });
    }
  });

  it('enforces exact semver ranges and every strict host-access branch', () => {
    const required = [
      { id: 'network', capability: 'network', reason: 'Network', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }], methods: ['GET'] } },
      { id: 'intercept', capability: 'network.intercept', reason: 'Intercept', scope: { origins: ['https://example.test'] } },
      { id: 'network-client', capability: 'network.client', reason: 'Client realtime', scope: { targets: [{ kind: 'connectedAccountOrigin', service: 'account' }], transports: ['websocket'] } },
      { id: 'filesystem', capability: 'filesystem', reason: 'Files', scope: { locations: [{ root: 'workspace', pathPrefix: 'src' }], access: ['read'] } },
      { id: 'process', capability: 'process', reason: 'Process', scope: { executables: [{ kind: 'systemTool', id: 'tool' }], envKeys: ['PATH'] } },
      { id: 'environment', capability: 'environment', reason: 'Environment', scope: { keys: ['HAPPIER_PROFILE'] } },
      { id: 'secrets', capability: 'secrets', reason: 'Secrets', scope: { secretIds: ['token'], access: ['read'] } },
      { id: 'accounts', capability: 'connectedAccounts', reason: 'Accounts', scope: { serviceRefs: ['account'], operations: ['use'] } },
      { id: 'sessions', capability: 'sessions', reason: 'Sessions', scope: { access: ['read'] } },
      { id: 'terminal', capability: 'terminal', reason: 'Terminal', scope: { operations: ['open'] } },
      { id: 'browser', capability: 'browser', reason: 'Browser', scope: { operations: ['read'], origins: ['http://localhost:3000'] } },
      { id: 'clipboard', capability: 'clipboard', reason: 'Clipboard', scope: { access: ['write'] } },
      { id: 'links', capability: 'externalLinks', reason: 'Links', scope: { origins: ['https://example.test'] } },
      { id: 'storage', capability: 'storage.synced', reason: 'Storage', scope: { enabled: true } },
      { id: 'mcp', capability: 'mcp', reason: 'MCP', scope: { serverRefs: ['server'], operations: ['callTools'] } },
    ];
    expect(ingestPluginManifestV2(manifest({
      hostAccess: { required },
      contributes: {
        connectedAccountDescriptors: [connectedAccountDescriptor('account')],
        systemTools: [{ id: 'tool', title: 'Tool', executableNames: ['tool'] }],
        mcp: { servers: [{ id: 'server', title: 'Server', kind: 'dynamic' }] },
      },
    })).ok).toBe(true);
    expect(ingestPluginManifestV2(manifest({ engines: { happier: 'banana1.2.3' } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ engines: { happier: '*' } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ version: '1.0.0-01' })).ok).toBe(false);
    expect(required).toHaveLength(15);
    expect(PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2.map((entry) => entry.capability)).toEqual(required.map((entry) => entry.capability));
    expect(PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2.map((entry) => [
      entry.capability,
      entry.authorizationClass,
    ])).toEqual([
      ['network', 'cooperativeDisclosure'],
      ['network.intercept', 'cooperativeDisclosure'],
      ['network.client', 'cooperativeDisclosure'],
      ['filesystem', 'cooperativeDisclosure'],
      ['process', 'cooperativeDisclosure'],
      ['environment', 'cooperativeDisclosure'],
      ['secrets', 'hostResourceSelection'],
      ['connectedAccounts', 'hostResourceSelection'],
      ['sessions', 'hostResourceSelection'],
      ['terminal', 'presentIntentOrOs'],
      ['browser', 'presentIntentOrOs'],
      ['clipboard', 'presentIntentOrOs'],
      ['externalLinks', 'presentIntentOrOs'],
      ['storage.synced', 'hostResourceSelection'],
      ['mcp', 'hostResourceSelection'],
    ]);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ ...required[0], scope: { targets: [{ kind: 'fixedOrigin', origin: 'ftp://example.test' }] } }] } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ ...required[0], scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://user:pass@example.test' }] } }] } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ ...required[0], scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }, { kind: 'fixedOrigin', origin: 'https://example.test' }] } }] } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ id: 'bad-env', capability: 'environment', reason: 'Bad', scope: { keys: ['*'] } }] } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ id: 'bare-process', capability: 'process', reason: 'Bad', scope: { executables: ['tool'] } }] } })).ok).toBe(false);
  });

  it('allows only independently selectable host-owned resources in optional host access', () => {
    const requests = [
      { id: 'network', capability: 'network', reason: 'Network', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] } },
      { id: 'intercept', capability: 'network.intercept', reason: 'Intercept', scope: { origins: ['https://example.test'] } },
      { id: 'network-client', capability: 'network.client', reason: 'Client realtime', scope: { targets: [{ kind: 'connectedAccountOrigin', service: 'account' }], transports: ['websocket'] } },
      { id: 'filesystem', capability: 'filesystem', reason: 'Files', scope: { locations: [{ root: 'workspace' }], access: ['read'] } },
      { id: 'process', capability: 'process', reason: 'Process', scope: { executables: [{ kind: 'systemTool', id: 'tool' }] } },
      { id: 'environment', capability: 'environment', reason: 'Environment', scope: { keys: ['HAPPIER_PROFILE'] } },
      { id: 'secrets', capability: 'secrets', reason: 'Secrets', scope: { secretIds: ['token'], access: ['read'] } },
      { id: 'accounts', capability: 'connectedAccounts', reason: 'Accounts', scope: { serviceRefs: ['account'], operations: ['use'] } },
      { id: 'sessions', capability: 'sessions', reason: 'Sessions', scope: { access: ['read'] } },
      { id: 'terminal', capability: 'terminal', reason: 'Terminal', scope: { operations: ['open'] } },
      { id: 'browser', capability: 'browser', reason: 'Browser', scope: { operations: ['read'] } },
      { id: 'clipboard', capability: 'clipboard', reason: 'Clipboard', scope: { access: ['write'] } },
      { id: 'links', capability: 'externalLinks', reason: 'Links', scope: { origins: ['https://example.test'] } },
      { id: 'storage', capability: 'storage.synced', reason: 'Storage', scope: { enabled: true } },
      { id: 'mcp', capability: 'mcp', reason: 'MCP', scope: { serverRefs: ['server'], operations: ['callTools'] } },
    ];
    const selectableCapabilities = new Set(['secrets', 'connectedAccounts', 'sessions', 'storage.synced', 'mcp']);
    const selectable = requests.filter((request) => selectableCapabilities.has(request.capability));
    const disclosureOnly = requests.filter((request) => !selectableCapabilities.has(request.capability));

    expect(PluginManifestHostAccessV2Schema.safeParse({ required: requests, optional: [] }).success).toBe(true);
    expect(PluginManifestHostAccessV2Schema.safeParse({ required: [], optional: selectable }).success).toBe(true);
    for (const request of disclosureOnly) {
      expect(PluginManifestHostAccessV2Schema.safeParse({ required: [], optional: [request] }).success).toBe(false);
    }
  });

  it('rejects removed contribution-family owners instead of silently preserving them', () => {
    for (const family of [
      'uiDescriptors', 'uiTranslations', 'surfacePlacements', 'hostedWeb', 'embeddedWebBundles',
      'reactNativeBundles', 'uiArtifacts', 'agentSettings', 'lifecycleHandlers',
    ]) {
      const result = ingestPluginManifestV2(manifest({ contributes: { [family]: [] } }));
      expect(result).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ path: ['contributes', family] })],
      });
    }
  });

  it('produces the same normalized record from UTF-8 bytes and a bundled object', () => {
    const input = manifest();
    const fromBytes = ingestPluginManifestV2(Buffer.from(JSON.stringify(input), 'utf8'));
    const fromObject = ingestPluginManifestV2(input);

    expect(fromBytes).toEqual(fromObject);
    expect(fromBytes.ok).toBe(true);
  });

  it('materializes every catalog family default when contributes is omitted', () => {
    const input = manifest();
    delete input.contributes;
    const result = ingestPluginManifestV2(input);
    expect(result).toEqual({ ok: true, manifest: expect.any(Object) });
    if (result.ok) {
      for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
        expect(entry.readEntries(result.manifest.contributes as Readonly<Record<string, unknown>>), entry.manifestKey).toEqual([]);
      }
    }
  });

  it('rejects raw input at the byte limit before JSON parsing', () => {
    const oversized = Buffer.alloc(PLUGIN_MANIFEST_INPUT_LIMITS.rawBytes + 1, 0x20);
    const result = ingestPluginManifestV2(oversized);

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_raw_budget_exceeded' })],
    });
  });

  it('applies the same raw-byte budget to bundled objects and rejects non-JSON objects', () => {
    const oversizedObject = manifest({ description: 'x'.repeat(PLUGIN_MANIFEST_INPUT_LIMITS.rawBytes) });
    expect(ingestPluginManifestV2(oversizedObject)).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_raw_budget_exceeded' })],
    });

    const cyclic = manifest();
    cyclic.self = cyclic;
    expect(ingestPluginManifestV2(cyclic)).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
    });
    expect(ingestPluginManifestV2({ ...manifest(), value: 1n })).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
    });
    for (const value of [undefined, () => undefined, Symbol('invalid'), Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ingestPluginManifestV2({ ...manifest(), metadata: { invalid: value } })).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
      });
    }
  });

  it('does not confuse an author-controlled ok key with an internal decode result', () => {
    expect(ingestPluginManifestV2({ ...manifest(), ok: false })).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid', path: ['ok'] })],
    });
  });

  it('accepts shared acyclic JSON subobjects with byte parity to serialization', () => {
    const shared = { note: 'shared' };
    const input = manifest({ metadata: { left: shared, right: shared } });
    expect(ingestPluginManifestV2(input)).toEqual(ingestPluginManifestV2(JSON.stringify(input)));
    expect(ingestPluginManifestV2(input).ok).toBe(true);
  });

  it('counts record-key UTF-8 bytes immediately against the aggregate string budget', () => {
    const atLimitKey = 'x'.repeat(PLUGIN_MANIFEST_INPUT_LIMITS.stringBytes);
    expect(ingestPluginManifestV2({ [atLimitKey]: null })).not.toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_aggregate_budget_exceeded' })],
    });

    const hugeKey = `${atLimitKey}x`;
    expect(ingestPluginManifestV2({ [hugeKey]: null })).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_aggregate_budget_exceeded' })],
    });
  });

  it('treats the manifest root as depth zero and rejects depth limit plus one', () => {
    let atLimit: unknown = null;
    for (let depth = 0; depth < PLUGIN_MANIFEST_INPUT_LIMITS.depth; depth += 1) atLimit = [atLimit];
    let overLimit: unknown = atLimit;
    overLimit = [overLimit];

    expect(ingestPluginManifestV2(atLimit)).not.toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_aggregate_budget_exceeded' })],
    });
    expect(ingestPluginManifestV2(overLimit)).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_aggregate_budget_exceeded' })],
    });
  });

  it('rejects aggregate JSON at the exact shared node boundary', () => {
    const recordEntries = PLUGIN_MANIFEST_INPUT_LIMITS.recordEntries - 1;
    const atLimit = Object.fromEntries(Array.from({ length: recordEntries }, (_, index) => [`k${index}`, null]));
    atLimit.items = Array.from({ length: PLUGIN_MANIFEST_INPUT_LIMITS.arrayEntries - 1 }, () => null);
    expect(ingestPluginManifestV2(atLimit)).not.toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_aggregate_budget_exceeded' })],
    });

    atLimit.items.push(null);
    const result = ingestPluginManifestV2(atLimit);

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_aggregate_budget_exceeded' })],
    });
  });

  it('rejects array and record entry limits at exactly limit plus one', () => {
    const arrayAtLimit = Array.from({ length: PLUGIN_MANIFEST_INPUT_LIMITS.arrayEntries }, () => null);
    expect(ingestPluginManifestV2(arrayAtLimit)).not.toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_aggregate_budget_exceeded' })],
    });
    expect(ingestPluginManifestV2([...arrayAtLimit, null])).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_aggregate_budget_exceeded' })],
    });

    const recordAtLimit = Object.fromEntries(
      Array.from({ length: PLUGIN_MANIFEST_INPUT_LIMITS.recordEntries }, (_, index) => [`k${index}`, null]),
    );
    expect(ingestPluginManifestV2(recordAtLimit)).not.toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_aggregate_budget_exceeded' })],
    });
    expect(ingestPluginManifestV2({ ...recordAtLimit, overflow: null })).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_aggregate_budget_exceeded' })],
    });
  });

  it('rejects unknown manifest and contribution-family fields with paths', () => {
    const root = ingestPluginManifestV2(manifest({ futureBehavior: true }));
    const family = ingestPluginManifestV2(manifest({ contributes: { futureFamily: [] } }));

    expect(root).toEqual({ ok: false, diagnostics: [expect.objectContaining({ path: ['futureBehavior'] })] });
    expect(family).toEqual({ ok: false, diagnostics: [expect.objectContaining({ path: ['contributes', 'futureFamily'] })] });
  });

  it('rejects duplicate local ids across contribution families', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        resources: [{ id: 'shared', kind: 'asset', path: 'shared.txt', contentType: 'text/plain' }],
        actions: [{ id: 'shared', title: 'Shared', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
      },
    }));

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_duplicate_contribution_id' })],
    });
  });

  it('does not place translation locales in the contribution local-id namespace', () => {
    expect(ingestPluginManifestV2(manifest({
      contributes: {
        resources: [{ id: 'en', kind: 'asset', path: 'en.json', contentType: 'application/json' }],
        ui: { translations: [{ locale: 'en', messages: { title: 'Title' } }] },
      },
    })).ok).toBe(true);
  });

  it('enforces the catalog local-id grammar for every identified family', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: { resources: [{ id: 'legacy.dotted', kind: 'asset', path: 'asset.txt', contentType: 'text/plain' }] },
    }));
    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_contribution_id' })],
    });
  });

  it('rejects dangling and wrong-family references', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        tools: [{ id: 'tool', title: 'Tool', name: 'tool', action: 'missing' }],
      },
    }));

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_dangling_reference' })],
    });
  });

  it('normalizes tools and commands as references to one declared action', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        actions: [{ id: 'summarize', title: 'Summarize', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
        tools: [{ id: 'summarize-tool', title: 'Summarize', name: 'summarize', action: 'summarize' }],
        commands: [{ id: 'summarize-command', title: 'Summarize', path: ['summarize'], action: 'summarize' }],
      },
    }));

    expect(result).toEqual({ ok: true, manifest: expect.any(Object) });
  });

  it('resolves action hostAccess request ids against the manifest disclosure owner', () => {
    const allowed = ingestPluginManifestV2(manifest({
      hostAccess: { required: [{ id: 'api', capability: 'network', reason: 'API', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] } }] },
      contributes: { actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe', hostAccess: ['api'] }] },
    }));
    expect(allowed.ok).toBe(true);
    expect(ingestPluginManifestV2(manifest({
      hostAccess: { required: [{ id: 'api', capability: 'network', reason: 'API', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] } }] },
      contributes: { actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe', hostAccess: ['api', 'api'] }] },
    })).ok).toBe(false);

    const dangling = ingestPluginManifestV2(manifest({
      contributes: { actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe', hostAccess: ['missing'] }] },
    }));
    expect(dangling).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_dangling_reference', path: ['contributes', 'actions', 0, 'hostAccess', 0] })],
    });
  });

  it('resolves hook hostAccess request ids against the same manifest disclosure owner', () => {
    const hook = {
      id: 'before-agent-request',
      on: 'agent.request.before',
      category: 'decision',
      scope: 'agent',
      executionKind: 'decide',
    };
    const request = {
      id: 'account',
      capability: 'connectedAccounts',
      reason: 'Use a selected account',
      scope: {
        serviceRefs: [{ pluginId: 'acme.accounts', localId: 'primary' }],
        operations: ['use'],
      },
    };

    expect(ingestPluginManifestV2(manifest({
      hostAccess: { required: [request], optional: [] },
      contributes: { hooks: [{ ...hook, hostAccess: ['account'] }] },
    })).ok).toBe(true);
    expect(ingestPluginManifestV2(manifest({
      contributes: { hooks: [{ ...hook, hostAccess: ['missing'] }] },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_dangling_reference',
        path: ['contributes', 'hooks', 0, 'hostAccess', 0],
      })],
    });
  });

  it('rejects a tool action reference that resolves to the wrong family or is dangling', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        resources: [{ id: 'not-an-action', kind: 'asset', path: 'asset.txt', contentType: 'text/plain' }],
        tools: [{ id: 'tool', title: 'Tool', name: 'tool', action: 'not-an-action' }],
      },
    }));

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' })],
    });
  });

  it('resolves structured cross-plugin references against the complete manifest set', () => {
    const owner = ingestPluginManifestV2(manifest({
      id: 'com.acme.actions',
      contributes: { actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }] },
    }));
    const consumer = ingestPluginManifestV2(manifest({
      id: 'com.acme.tools',
      contributes: { tools: [{ id: 'runner', name: 'runner', title: 'Runner', action: { pluginId: 'com.acme.actions', localId: 'run' } }] },
    }));
    expect(owner.ok).toBe(true);
    expect(consumer.ok).toBe(true);
    if (!owner.ok || !consumer.ok) return;
    expect(resolvePluginManifestSetReferencesV2([owner.manifest, consumer.manifest])).toEqual({ ok: true });
    expect(resolvePluginManifestSetReferencesV2([consumer.manifest])).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_dangling_reference' })],
    });

    const wrongOwner = ingestPluginManifestV2(manifest({
      id: 'com.acme.actions',
      contributes: { resources: [{ id: 'run', kind: 'asset', path: 'run.txt', contentType: 'text/plain' }] },
    }));
    expect(wrongOwner.ok).toBe(true);
    if (wrongOwner.ok) expect(resolvePluginManifestSetReferencesV2([wrongOwner.manifest, consumer.manifest])).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' })],
    });
  });

  it('validates host-access contribution references by family', () => {
    const contributes = {
      connectedAccountDescriptors: [connectedAccountDescriptor('account')],
      scmHostingProviders: [{ id: 'scm', title: 'SCM', kind: 'github', capabilities: ['detect'] }],
      systemTools: [{ id: 'tool', title: 'Tool', executableNames: ['tool'] }],
      managedDependencies: [managedDependency('managed')],
      mcp: { servers: [{ id: 'server', title: 'Server', kind: 'dynamic' }] },
    };
    const required = [
      { id: 'account-origin', capability: 'network', reason: 'Account', scope: { targets: [{ kind: 'connectedAccountOrigin', service: 'account' }] } },
      { id: 'scm-origin', capability: 'network', reason: 'SCM', scope: { targets: [{ kind: 'scmProviderOrigin', provider: 'scm' }] } },
      { id: 'tool', capability: 'process', reason: 'Tool', scope: { executables: [{ kind: 'systemTool', id: 'tool' }] } },
      { id: 'managed', capability: 'process', reason: 'Managed', scope: { executables: [{ kind: 'managedDependency', id: 'managed' }] } },
      { id: 'accounts', capability: 'connectedAccounts', reason: 'Accounts', scope: { serviceRefs: ['account'], operations: ['use'] } },
      { id: 'mcp', capability: 'mcp', reason: 'MCP', scope: { serverRefs: ['server'], operations: ['callTools'] } },
    ];
    expect(ingestPluginManifestV2(manifest({ contributes, hostAccess: { required } })).ok).toBe(true);

    for (const request of required) {
      const dangling = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
      const serialized = JSON.stringify(dangling).replace(/"(account|scm|tool|managed|server)"/g, '"missing"');
      expect(ingestPluginManifestV2(manifest({ contributes, hostAccess: { required: [JSON.parse(serialized)] } }))).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'plugin_manifest_dangling_reference' })],
      });
    }

    const wrongFamily = ingestPluginManifestV2(manifest({
      contributes: { ...contributes, resources: [{ id: 'wrong', kind: 'asset', path: 'wrong.txt', contentType: 'text/plain' }] },
      hostAccess: { required: [{ id: 'wrong', capability: 'process', reason: 'Wrong', scope: { executables: [{ kind: 'systemTool', id: 'wrong' }] } }] },
    }));
    expect(wrongFamily).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' })],
    });
  });

  it('rejects public connected-account host adapter selection at manifest ingestion', () => {
    const descriptor = {
      ...connectedAccountDescriptor('account'),
      hostAdapter: 'githubOAuth',
    };

    expect(ingestPluginManifestV2(manifest({
      contributes: { connectedAccountDescriptors: [descriptor] },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid' })],
    });
  });

  it('resolves structured cross-plugin host-access references as one manifest batch', () => {
    const owner = ingestPluginManifestV2(manifest({
      id: 'com.acme.host-owner',
      contributes: {
        connectedAccountDescriptors: [connectedAccountDescriptor('account')],
        scmHostingProviders: [{ id: 'scm', title: 'SCM', kind: 'github', capabilities: ['detect'] }],
        systemTools: [{ id: 'tool', title: 'Tool', executableNames: ['tool'] }],
        managedDependencies: [managedDependency('managed')],
        mcp: { servers: [{ id: 'server', title: 'Server', kind: 'dynamic' }] },
      },
    }));
    const ref = (localId: string) => ({ pluginId: 'com.acme.host-owner', localId });
    const consumer = ingestPluginManifestV2(manifest({
      id: 'com.acme.host-consumer',
      hostAccess: { required: [
        { id: 'account', capability: 'network', reason: 'Account', scope: { targets: [{ kind: 'connectedAccountOrigin', service: ref('account') }] } },
        { id: 'scm', capability: 'network', reason: 'SCM', scope: { targets: [{ kind: 'scmProviderOrigin', provider: ref('scm') }] } },
        { id: 'tool', capability: 'process', reason: 'Tool', scope: { executables: [{ kind: 'systemTool', id: ref('tool') }] } },
        { id: 'managed', capability: 'process', reason: 'Managed', scope: { executables: [{ kind: 'managedDependency', id: ref('managed') }] } },
        { id: 'accounts', capability: 'connectedAccounts', reason: 'Accounts', scope: { serviceRefs: [ref('account')], operations: ['use'] } },
        { id: 'mcp', capability: 'mcp', reason: 'MCP', scope: { serverRefs: [ref('server')], operations: ['callTools'] } },
      ] },
    }));
    expect(owner.ok).toBe(true);
    expect(consumer.ok).toBe(true);
    if (!owner.ok || !consumer.ok) return;
    expect(resolvePluginManifestSetReferencesV2([owner.manifest, consumer.manifest])).toEqual({ ok: true });
    expect(resolvePluginManifestSetReferencesV2([consumer.manifest])).toEqual({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'plugin_manifest_dangling_reference', path: expect.arrayContaining(['hostAccess']) }),
      ]),
    });
  });

});
