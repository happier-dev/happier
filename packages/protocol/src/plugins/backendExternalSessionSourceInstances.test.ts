import { describe, expect, it } from 'vitest';

import { PluginBackendExternalSessionSourceDeclarationV1Schema } from './backendDefinitionV1.js';
import { materializeExternalSessionSourceInstances } from './backendExternalSessionSourceInstances.js';

const DECLARATION = PluginBackendExternalSessionSourceDeclarationV1Schema.parse({
  sourceKind: 'opencodeServer',
  schema: {
    fields: [
      { name: 'kind', kind: 'literal', value: 'opencodeServer' },
      { name: 'baseUrl', kind: 'unknown', optional: true },
      { name: 'directory', kind: 'unknown', optional: true },
      { name: 'managedEndpoint', kind: 'unknown', optional: true },
    ],
  },
  key: {
    segments: [
      { kind: 'literal', value: 'opencodeServer' },
      { kind: 'field', field: 'baseUrl' },
      { kind: 'field', field: 'directory' },
    ],
  },
  instances: [
    { kind: 'default', constants: { managedEndpoint: true } },
    {
      kind: 'agentSetting',
      settingId: 'opencodeServerBaseUrl',
      byServerIdSettingId: 'opencodeServerBaseUrlByServerIdV1',
      field: 'baseUrl',
      normalization: 'httpOrigin',
    },
  ],
});

const CONNECTED_DECLARATION = PluginBackendExternalSessionSourceDeclarationV1Schema.parse({
  sourceKind: 'codexHome',
  schema: {
    fields: [
      { name: 'kind', kind: 'literal', value: 'codexHome' },
      { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
      { name: 'connectedServiceId', kind: 'string', optional: true },
      { name: 'connectedServiceProfileId', kind: 'string', optional: true },
    ],
  },
  key: { segments: [{ kind: 'literal', value: 'codexHome' }] },
  instances: [{
    kind: 'connectedServiceProfiles',
    serviceId: 'openai-codex',
    constants: { home: 'connectedService' },
    fields: { serviceId: 'connectedServiceId', profileId: 'connectedServiceProfileId' },
  }],
});

const CONFIGURED_PATH_DECLARATION_INPUT = {
  sourceKind: 'agentDir',
  schema: {
    fields: [
      { name: 'kind', kind: 'literal', value: 'agentDir' },
      { name: 'path', kind: 'string', nullish: true },
    ],
  },
  key: { segments: [{ kind: 'literal', value: 'agentDir' }, { kind: 'field', field: 'path' }] },
  instances: [
    { kind: 'default', constants: {} },
    {
      kind: 'agentSettingOverride',
      settingId: 'agentDirPath',
      field: 'path',
      normalization: 'configuredPath',
      constants: {},
    },
  ],
} as const;

describe('materializeExternalSessionSourceInstances', () => {
  it('replaces the paired default with one trimmed configured path', () => {
    const declaration = PluginBackendExternalSessionSourceDeclarationV1Schema.parse(
      CONFIGURED_PATH_DECLARATION_INPUT,
    );

    expect(materializeExternalSessionSourceInstances({
      declaration,
      agentSettings: { agentDirPath: '  ~/.isolated/agent  ' },
    }).instances).toEqual([{
      sourceKind: 'agentDir',
      source: { kind: 'agentDir', path: '~/.isolated/agent' },
      origin: {
        kind: 'agentSetting',
        settingId: 'agentDirPath',
        value: '~/.isolated/agent',
      },
    }]);
  });

  it('retains the paired default when the configured path is absent or invalid', () => {
    for (const agentDirPath of [undefined, '', '   ', null, 42]) {
      const declaration = PluginBackendExternalSessionSourceDeclarationV1Schema.parse(
        CONFIGURED_PATH_DECLARATION_INPUT,
      );
      expect(materializeExternalSessionSourceInstances({
        declaration,
        agentSettings: { agentDirPath },
      }).instances.map((entry) => entry.source)).toEqual([{ kind: 'agentDir' }]);
    }
  });

  it('materializes only the declared default when no agent setting is configured', () => {
    const result = materializeExternalSessionSourceInstances({
      declaration: DECLARATION,
      agentSettings: {},
      activeServerId: 'cloud',
    });

    expect(result.issues).toEqual([]);
    expect(result.instances).toEqual([{
      sourceKind: 'opencodeServer',
      source: { managedEndpoint: true, kind: 'opencodeServer' },
      origin: { kind: 'default' },
    }]);
  });

  it('materializes an attach source from the active-server-bound agent setting', () => {
    const result = materializeExternalSessionSourceInstances({
      declaration: DECLARATION,
      agentSettings: {
        opencodeServerBaseUrl: 'http://127.0.0.1:9999',
        opencodeServerBaseUrlByServerIdV1: { cloud: 'http://127.0.0.1:4096' },
      },
      activeServerId: 'cloud',
    });

    expect(result.instances.map((entry) => entry.source)).toEqual([
      { managedEndpoint: true, kind: 'opencodeServer' },
      { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
    ]);
    expect(result.instances[1]?.origin).toEqual({
      kind: 'agentSetting',
      settingId: 'opencodeServerBaseUrl',
      value: 'http://127.0.0.1:4096/',
    });
  });

  it('falls back to the unscoped agent setting when the active server has no binding', () => {
    const result = materializeExternalSessionSourceInstances({
      declaration: DECLARATION,
      agentSettings: {
        opencodeServerBaseUrl: 'http://localhost:4096',
        opencodeServerBaseUrlByServerIdV1: { other: 'http://127.0.0.1:1234' },
      },
      activeServerId: 'cloud',
    });

    expect(result.instances.map((entry) => entry.source)).toEqual([
      { managedEndpoint: true, kind: 'opencodeServer' },
      { kind: 'opencodeServer', baseUrl: 'http://localhost:4096/' },
    ]);
  });

  it('yields no attach source for values the origin policy rejects', () => {
    const rejected = [
      '',
      '   ',
      'not-a-url',
      'ftp://127.0.0.1:4096',
      'http://user:secret@127.0.0.1:4096',
      'https://user:secret@opencode.example.com',
      42,
      null,
    ];

    for (const value of rejected) {
      const result = materializeExternalSessionSourceInstances({
        declaration: DECLARATION,
        agentSettings: { opencodeServerBaseUrlByServerIdV1: { cloud: value } },
        activeServerId: 'cloud',
      });
      expect(result.instances.map((entry) => entry.origin.kind)).toEqual(['default']);
    }
  });

  /**
   * A user may run their own OpenCode server anywhere and reach it however
   * they like. Requiring TLS for a non-loopback host would force the user to
   * terminate HTTPS in front of their own process to attach to it at all.
   */
  it('keeps a rejected persisted LAN HTTP override inert, reports it, and preserves the managed default', () => {
    const result = materializeExternalSessionSourceInstances({
      declaration: DECLARATION,
      agentSettings: { opencodeServerBaseUrl: 'http://192.168.1.10:4096' },
      activeServerId: null,
    });

    expect(result.instances).toEqual([{
      sourceKind: 'opencodeServer',
      source: { managedEndpoint: true, kind: 'opencodeServer' },
      origin: { kind: 'default' },
    }]);
    expect(result.issues).toEqual([{
      code: 'invalid_agent_setting_endpoint',
      settingId: 'opencodeServerBaseUrl',
      rejection: 'host',
    }]);
  });

  it('keeps a supported HTTPS reverse-proxy base path while dropping query and fragment', () => {
    const result = materializeExternalSessionSourceInstances({
      declaration: DECLARATION,
      agentSettings: { opencodeServerBaseUrl: 'https://opencode.example.com/some/path?query=1#fragment' },
      activeServerId: null,
    });

    expect(result.instances[1]?.source).toEqual({
      kind: 'opencodeServer',
      baseUrl: 'https://opencode.example.com/some/path',
    });
  });

  it('materializes connected profiles and reports malformed profile identifiers', () => {
    const materialized = materializeExternalSessionSourceInstances({
      declaration: CONNECTED_DECLARATION,
      connectedServices: [{
        serviceId: 'openai-codex',
        profiles: [
          { profileId: 'profile-a', status: 'connected' },
          { profileId: 'profile-b', status: 'needs_reauth' },
        ],
      }],
    });
    const malformed = materializeExternalSessionSourceInstances({
      declaration: CONNECTED_DECLARATION,
      connectedServices: [{
        serviceId: 'openai-codex',
        profiles: [{ profileId: '  ', status: 'connected' }],
      }],
    });

    expect(materialized.issues).toEqual([]);
    expect(materialized.instances).toEqual([{
      sourceKind: 'codexHome',
      source: {
        home: 'connectedService',
        kind: 'codexHome',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-a',
      },
      origin: {
        kind: 'connectedServiceProfile',
        serviceId: 'openai-codex',
        profileId: 'profile-a',
      },
    }]);
    expect(malformed.instances).toEqual([]);
    expect(malformed.issues).toEqual([
      { code: 'malformed_connected_service_profile_id', serviceId: 'openai-codex' },
    ]);
  });
});
