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
          placement: 'primary',
          dangerLevel: 'safe',
        }],
      },
    });
    if (!ingestion.ok) throw new Error('Fixture must normalize');
    const diagnosticsByPluginId = {};
    const policy = readBundledActivationPolicy({
      target: {
        provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'com.acme.policy',
        manifestPath: '@acme/policy', manifestDigest: 'sha256:fixture', daemonEntryPath: '@acme/policy',
        sourceSpec: { kind: 'bundled', locator: '@acme/policy', trustPolicy: 'local_trusted', installPolicy: 'link' },
        manifest: ingestion.manifest,
      },
      moduleNamespace: { PLUGIN_MANIFEST: { malformed: true } },
      diagnosticsByPluginId,
    });

    expect(policy?.declaredActionIds).toEqual(['run']);
    expect(diagnosticsByPluginId).toEqual({});
  });

  it('projects strict host access declarations to the existing agent runtime service gates', () => {
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
    expect(policy.permissions).toEqual(expect.arrayContaining([
      'terminal.host.control',
      'events.session.subscribe',
      'session.hooks.control',
    ]));

    for (const expectation of [
      {
        access: ['read'] as const,
        runtimeCapability: null,
        permission: 'events.session.subscribe',
        absentRuntimeCapability: 'sessionHooks',
        absentPermission: 'session.hooks.control',
      },
      {
        access: ['control'] as const,
        runtimeCapability: 'sessionHooks',
        permission: 'session.hooks.control',
        absentRuntimeCapability: null,
        absentPermission: 'events.session.subscribe',
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
      expect(leastPrivilegePolicy.permissions).toContain(expectation.permission);
      expect(leastPrivilegePolicy.permissions).not.toContain(expectation.absentPermission);
      if (expectation.runtimeCapability === null) {
        expect(leastPrivilegePolicy.runtimeCapabilities).not.toContain(expectation.absentRuntimeCapability);
      } else {
        expect(leastPrivilegePolicy.runtimeCapabilities).toContain(expectation.runtimeCapability);
      }
    }
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
          capability: 'storage.synced',
          reason: 'Synchronize plugin state when the user selects this resource.',
          scope: { enabled: true },
        }],
      },
    });
    if (!ingestion.ok) throw new Error('Fixture must normalize');

    const policy = buildActivationPolicy(ingestion.manifest);

    expect(policy.permissions).toEqual([]);
    expect(policy.permissionDeclarations).toEqual([]);
    expect('optionalPermissionDeclarations' in policy).toBe(false);
  });
});
