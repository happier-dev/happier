import { describe, expect, it } from 'vitest';

import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import { buildActivationPolicy, readBundledActivationPolicy } from './policy';

describe('bundled activation policy', () => {
  it('consumes the normalized target record without reparsing the module export', () => {
    const ingestion = ingestCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'com.acme.policy',
      version: '1.0.0',
      displayName: 'Policy',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      contributes: {
        actions: [{
          id: 'run',
          title: 'Run',
          scopes: ['session'],
          surfaces: ['cli'],
          execution: { target: 'daemon' },
          placementBindings: ['primary'],
          dangerLevel: 'safe',
        }],
      },
    });
    if (!ingestion.ok) throw new Error('Fixture must normalize');
    const diagnosticsByPluginId = {};
    const policy = readBundledActivationPolicy({
      target: {
        provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'com.acme.policy',
        manifestPath: '@acme/policy', daemonEntryPath: '@acme/policy',
        sourceSpec: { kind: 'bundled', locator: '@acme/policy', trustPolicy: 'local_trusted', installPolicy: 'link' },
        manifest: ingestion.manifest,
      },
      moduleNamespace: { PLUGIN_MANIFEST: { malformed: true } },
      diagnosticsByPluginId,
    });

    expect(policy?.declaredActionIds).toEqual(['run']);
    expect(diagnosticsByPluginId).toEqual({});
  });

  it('derives agent runtime services from host access without redundant legacy permission gates', () => {
    const ingestion = ingestCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'com.acme.agent-runtime-services',
      version: '1.0.0',
      displayName: 'Agent runtime services',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      hostAccess: {
        required: [
          {
            id: 'terminal-control',
            capability: 'terminal',
            reason: 'Control the host terminal for the declared Agent.',
            scope: { operations: ['open', 'send', 'resize', 'close'] },
          },
          {
            id: 'session-hook-control',
            capability: 'sessions',
            reason: 'Read lifecycle events and control authenticated hooks for the current Agent session.',
            scope: { access: ['read', 'control'] },
          },
        ],
        optional: [],
      },
      contributes: {
        agents: [{
          id: 'agent-runtime-services',
          title: 'Agent runtime services',
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            surfaces: ['terminal'],
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        }],
      },
    });
    if (!ingestion.ok) throw new Error('Fixture must normalize');

    const policy = buildActivationPolicy(ingestion.manifest);

    expect(policy.runtimeCapabilities).toEqual(expect.arrayContaining(['terminalHost', 'sessionHooks']));
    expect(policy).not.toHaveProperty('permissions');
    expect(policy).not.toHaveProperty('permissionDeclarations');

    for (const expectation of [
      {
        access: ['read'] as const,
        runtimeCapability: null,
        absentRuntimeCapability: 'sessionHooks',
      },
      {
        access: ['control'] as const,
        runtimeCapability: 'sessionHooks',
        absentRuntimeCapability: null,
      },
    ]) {
      const leastPrivilegeIngestion = ingestCanonicalPluginManifest({
        schemaVersion: 2,
        id: `com.acme.sessions-${expectation.access[0]}`,
        version: '1.0.0',
        displayName: `Sessions ${expectation.access[0]}`,
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/plugin.js' },
        hostAccess: {
          required: [{
            id: `sessions-${expectation.access[0]}`,
            capability: 'sessions',
            reason: `Exercise ${expectation.access[0]} access.`,
            scope: { access: [...expectation.access] },
          }],
          optional: [],
        },
      });
      if (!leastPrivilegeIngestion.ok) throw new Error('Least-privilege fixture must normalize');

      const leastPrivilegePolicy = buildActivationPolicy(leastPrivilegeIngestion.manifest);
      expect(leastPrivilegePolicy).not.toHaveProperty('permissions');
      if (expectation.runtimeCapability === null) {
        expect(leastPrivilegePolicy.runtimeCapabilities).not.toContain(expectation.absentRuntimeCapability);
      } else {
        expect(leastPrivilegePolicy.runtimeCapabilities).toContain(expectation.runtimeCapability);
      }
    }
  });

  it('keeps filesystem disclosure out of the user-grant vocabulary', () => {
    const ingestion = ingestCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'com.acme.delete-files',
      version: '1.0.0',
      displayName: 'Delete files',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      hostAccess: {
        required: [{
          id: 'workspace-cleanup',
          capability: 'filesystem',
          reason: 'Remove generated workspace artifacts.',
          scope: {
            locations: [{ root: 'workspace', pathPrefix: 'output' }],
            access: ['delete'],
          },
        }],
        optional: [],
      },
    });
    if (!ingestion.ok) throw new Error('Fixture must normalize');

    const policy = buildActivationPolicy(ingestion.manifest);

    expect(policy).not.toHaveProperty('permissions');
    expect(policy).not.toHaveProperty('permissionDeclarations');
  });

  it('keeps non-runtime contribution families out of carried runtime authority', () => {
    const ingestion = ingestCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'com.acme.agent-with-system-tool',
      version: '1.0.0',
      displayName: 'Agent with system tool',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      contributes: {
        agents: [{
          id: 'agent-with-system-tool',
          title: 'Agent with system tool',
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        }],
        systemTools: [{
          id: 'agent-cli',
          title: 'Agent CLI',
          executableNames: ['agent-cli'],
        }],
      },
    });
    if (!ingestion.ok) throw new Error('Fixture must normalize');

    expect(buildActivationPolicy(ingestion.manifest).runtimeCapabilities)
      .toEqual(['agents']);
  });

  it('keeps selectable optional host resources out of the legacy activation permission model', () => {
    const ingestion = ingestCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'com.acme.optional-storage',
      version: '1.0.0',
      displayName: 'Optional storage',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      hostAccess: {
        required: [],
        optional: [{
          id: 'synced-storage',
          capability: 'storage.account',
          reason: 'Synchronize plugin state when the user selects this resource.',
          scope: { enabled: true },
        }],
      },
    });
    if (!ingestion.ok) throw new Error('Fixture must normalize');

    const policy = buildActivationPolicy(ingestion.manifest);

    expect(policy).not.toHaveProperty('permissions');
    expect(policy).not.toHaveProperty('permissionDeclarations');
    expect('optionalPermissionDeclarations' in policy).toBe(false);
  });

  it('keeps request-interceptor scope with its declared policy rather than duplicating it into HostAccess', () => {
    const ingestion = ingestCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'com.acme.request-policy-disclosure',
      version: '1.0.0',
      displayName: 'Request policy disclosure',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {
        requestInterceptors: [{
          id: 'inspect-api',
          origins: ['https://api.example.test', 'https://other.example.test'],
        }],
      },
    });
    if (!ingestion.ok) throw new Error('Fixture must normalize');

    const policy = buildActivationPolicy(ingestion.manifest);
    expect(policy).not.toHaveProperty('permissionDeclarations');
    expect('declaredRequestInterceptors' in policy).toBe(false);
  });
});
