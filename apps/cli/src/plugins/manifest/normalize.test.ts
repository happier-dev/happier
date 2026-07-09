import { describe, expect, it } from 'vitest';

import { readCanonicalPluginManifest } from './normalize';

describe('readCanonicalPluginManifest', () => {
  it('keeps managed dependency contribution vocabulary canonical when normalizing v2 manifests', () => {
    const manifest = readCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'acme.dependencies',
      version: '1.0.0',
      displayName: 'Acme Dependencies',
      engines: { happier: '^1.0.0' },
      uses: ['managedDependencies'],
      entrypoints: { main: './daemon.mjs' },
      permissions: { required: [], optional: [] },
      contributes: {
        managedDependencies: [{
          id: 'acme-cli',
          key: 'acme-cli',
          kind: 'dep',
          version: '1',
          capabilityId: 'dep.acme-cli',
          display: { name: 'Acme CLI' },
          description: 'Acme CLI dependency',
          source: {
            kind: 'manual_only',
            setupUrl: 'https://example.com/acme-cli',
          },
          binary: {
            commands: ['acme-cli'],
            systemFirst: true,
          },
          defaultPolicy: {
            autoInstallWhenNeeded: false,
            autoUpdateMode: 'notify',
          },
          consent: {
            install: 'required',
            update: 'required',
          },
        }],
      },
    });

    expect(manifest?.contributes).toHaveProperty('managedDependencies');
    expect(manifest?.contributes).not.toHaveProperty('installables');
    expect(manifest?.contributes.managedDependencies).toEqual([
      expect.objectContaining({
        id: 'acme-cli',
        key: 'acme-cli',
        capabilityId: 'dep.acme-cli',
      }),
    ]);
  });

  it('keeps canonical agent contribution vocabulary when normalizing v2 manifests', () => {
    const manifest = readCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'acme.agent',
      version: '1.0.0',
      displayName: 'Acme Agent',
      engines: { happier: '^1.0.0' },
      uses: ['agents'],
      entrypoints: { main: './daemon.mjs' },
      permissions: { required: [], optional: [] },
      contributes: {
        agents: [{
          id: 'acme.agent',
          runtime: { kind: 'custom' },
          catalogAgentId: 'claude',
          display: { name: 'Acme Agent' },
          ownedBackendIds: ['acme.backend'],
          agentCliRuntime: {
            id: 'acme.agent',
            title: 'Acme Agent',
            binaryName: 'acme-agent',
            args: ['run'],
            executableCandidates: ['acme-agent'],
            knownUserBinDirSuffixes: [],
            sourcePreferenceDefault: 'system-first',
            managedInstall: null,
            manualInstallKind: 'none',
            manualInstallRecipes: {
              common: [],
              platform: {},
            },
            acceptsJavaScriptFileOverride: false,
          },
        }],
      },
    });

    expect(manifest?.uses).toEqual(['agents']);
    expect(manifest?.entrypoints).toEqual({ main: './daemon.mjs' });
    expect(manifest).not.toHaveProperty('runtime');
    expect(manifest).not.toHaveProperty('targets');
    expect(manifest?.contributes).not.toHaveProperty('providers');
    expect(manifest?.contributes).not.toHaveProperty('backends');
    expect(manifest?.contributes.agentRuntimes[0]).toMatchObject({
      id: 'acme.agent',
      runtimeKind: 'custom',
      agentId: 'acme.agent',
      catalogAgentId: 'claude',
    });
    expect(manifest?.contributes.agents[0]).toMatchObject({
      id: 'acme.agent',
      catalogAgentId: 'claude',
      agentCliRuntime: {
        binaryName: 'acme-agent',
      },
    });
    expect(manifest?.contributes.agents[0]).not.toHaveProperty('providerAgentId');
    expect(manifest?.contributes.agents[0]).not.toHaveProperty('providerCliRuntime');
  });

  it('preserves plugin UI and browser contribution families from v2 manifests', () => {
    const display = {
      titleKey: 'title',
      descriptionKey: 'description',
      iconToken: 'browser',
      tone: 'info',
    } as const;
    const browserDisplay = {
      title: 'Preview',
      iconToken: 'browser',
      tone: 'info',
    } as const;
    const browserTarget = {
      kind: 'hostedPluginWeb',
      targetId: 'target_1',
      pluginId: 'acme.ui',
      contributionId: 'preview-web',
      display: browserDisplay,
    } as const;

    const manifest = readCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'acme.ui',
      version: '1.0.0',
      displayName: 'Acme UI',
      engines: { happier: '^1.0.0' },
      uses: [],
      entrypoints: { main: './daemon.mjs' },
      permissions: { required: [], optional: [] },
      contributes: {
        uiTranslations: [{
          locales: {
            en: {
              title: 'Preview',
              description: 'Open the preview',
            },
          },
        }],
        structuredMessages: [{
          id: 'preview-card',
          kind: 'acme.preview/preview-card.v1',
          payloadSchema: { type: 'object' },
          renderer: { kind: 'host', rendererId: 'summaryCard' },
          display,
        }],
        surfacePlacements: [{
          id: 'preview-pane',
          placement: 'session.preview',
          target: { kind: 'session', sessionIdPath: '/session/id' },
          renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
          display,
        }],
        sessionHeaderActions: [{
          id: 'open-preview',
          action: {
            id: 'open-preview',
            kind: 'openSurface',
            labelKey: 'title',
            target: { surfaceId: 'preview-pane' },
          },
          display,
          placement: { area: 'primary', overflow: 'auto' },
        }],
        hostedWeb: [{
          id: 'preview-web',
          service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
          entry: { routeMode: 'hostOrigin', path: '/' },
          bridge: { allowedMessages: ['ready', 'heightChanged'] },
          sandbox: { scripts: true },
          security: {},
          fallback: { kind: 'unavailable' },
          display,
        }],
        reactNativeBundles: [{
          id: 'native-preview',
          bundle: {
            platform: 'ios',
            channel: 'internal',
            integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
          },
          entry: { exportName: 'renderSurface' },
          compatibility: {
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.79.0',
            supportedPlatforms: ['ios'],
            supportedChannels: ['internal'],
          },
          hostApi: { minVersion: '1.0.0' },
          fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
          display,
        }],
        uiArtifacts: [{
          id: 'native-preview-ios',
          contributionId: 'native-preview',
          contributionFamily: 'reactNativeBundles',
          artifactKind: 'reactNativeBundle',
          platform: 'ios',
          channel: 'internal',
          integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
          compatibility: {
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.79.0',
          },
          byteSize: 1024,
          contentType: 'application/javascript',
        }],
        browserTargets: [{ id: 'preview-target', target: browserTarget, display: browserDisplay }],
        browserActions: [{ id: 'open-preview', kind: 'openTarget', target: browserTarget, display: browserDisplay }],
      },
    });

    expect(manifest?.contributes.uiTranslations?.[0]?.locales.en?.title).toBe('Preview');
    expect(manifest?.contributes.structuredMessages?.[0]?.id).toBe('preview-card');
    expect(manifest?.contributes.surfacePlacements?.find((placement) => placement.id === 'preview-pane')?.placement).toBe('session.preview');
    expect(manifest?.contributes.sessionHeaderActions?.[0]?.id).toBe('open-preview');
    expect(manifest?.contributes.hostedWeb?.[0]?.id).toBe('preview-web');
    expect(manifest?.contributes.reactNativeBundles?.[0]?.id).toBe('native-preview');
    expect(manifest?.contributes.uiArtifacts?.[0]?.id).toBe('native-preview-ios');
    expect(manifest?.contributes.browserTargets?.[0]?.target.kind).toBe('hostedPluginWeb');
    expect(manifest?.contributes.browserActions?.[0]?.kind).toBe('openTarget');
  });

  it('preserves surviving static MCP contribution families from v2 manifests', () => {
    const manifest = readCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'acme.mcp',
      version: '1.0.0',
      displayName: 'Acme MCP',
      engines: { happier: '^1.0.0' },
      uses: ['mcp'],
      entrypoints: { main: './daemon.mjs' },
      permissions: { required: [], optional: [] },
      contributes: {
        mcp: {
          servers: [
            {
              id: 'acme.hosted',
              kind: 'mcp.server',
              version: '1.0.0',
              name: 'acme-hosted',
              transport: 'hosted',
            },
          ],
          discoveryProviders: [
            {
              id: 'acme.discovery',
              kind: 'mcp.discoveryProvider',
              version: '1.0.0',
              agentId: 'acme',
            },
          ],
        },
      },
    });

    expect(manifest?.contributes.mcp?.servers.map((server) => server.name)).toEqual(['acme-hosted']);
    expect(manifest?.contributes.mcp?.discoveryProviders.map((provider) => provider.agentId)).toEqual(['acme']);
  });

  it('preserves provider-account settings contributions from v2 manifests', () => {
    const manifest = readCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'acme.provider.settings',
      version: '1.0.0',
      displayName: 'Acme Provider Settings',
      engines: { happier: '^1.0.0' },
      uses: ['agents'],
      entrypoints: { main: './daemon.mjs' },
      permissions: { required: [], optional: [] },
      contributes: {
        agents: [{
          id: 'acme',
          runtime: { kind: 'custom' },
          display: { name: 'Acme' },
          ownedBackendIds: [],
        }],
        agentSettings: [
          {
            id: 'acme.agentSettings.v1',
            kind: 'agentSettings.v1',
            agentId: 'acme',
            fields: [
              {
                id: 'acmeBackendMode',
                schema: { kind: 'enum', values: ['managed', 'external'] },
                default: 'managed',
                description: 'Preferred Acme backend mode',
              },
            ],
          },
        ],
      },
    });

    expect(manifest?.contributes.agentSettings?.[0]).toEqual(
      expect.objectContaining({
        id: 'acme.agentSettings.v1',
        agentId: 'acme',
        fields: [
          expect.objectContaining({
            id: 'acmeBackendMode',
            default: 'managed',
          }),
        ],
      }),
    );
  });
});
