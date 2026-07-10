import { describe, expect, it } from 'vitest';

import { OPENCODE_UI_DESCRIPTOR } from './descriptor.js';
import * as openCodeUiEntrypoint from './index.js';

const FORBIDDEN_NO_EXECUTE_KEYS = new Set([
  'projection',
  'importName',
  'label',
  'uiBehaviorOverride',
  'sessionProviderBehavior',
  'messageMetaOverride',
  'agentSettings',
  'visibleMessageResolver',
  'svgIconXml',
]);

function collectNoExecuteViolations(value: unknown, path = 'descriptor'): string[] {
  if (typeof value === 'function') return [`${path}: function value`];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectNoExecuteViolations(item, `${path}[${index}]`));
  }

  return Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, child]) => {
    const violations: string[] = [];
    if (FORBIDDEN_NO_EXECUTE_KEYS.has(key)) violations.push(`${path}.${key}: executable projection key`);
    if (key === 'source' && typeof child === 'string') {
      violations.push(`${path}.${key}: executable projection source`);
    }
    if (typeof child === 'string' && /#[0-9a-fA-F]{3,8}\b/.test(child)) {
      violations.push(`${path}.${key}: raw color literal`);
    }
    return [...violations, ...collectNoExecuteViolations(child, `${path}.${key}`)];
  });
}

describe('OPENCODE_UI_DESCRIPTOR', () => {
  it('projects OpenCode UI facts from the plugin descriptor', () => {
    expect(OPENCODE_UI_DESCRIPTOR).toMatchObject({
      kind: 'plugin.ui.v1',
      pluginId: 'opencode',
      agentId: 'opencode',
      version: 1,
      display: {
        nameKey: 'agentInput.agent.opencode',
        connectedService: {
          serviceId: null,
          labelKey: 'agentInput.agent.opencode',
        },
        icon: { assetId: 'opencode' },
      },
      settings: {
        kind: 'agentSettings.v1',
        descriptorId: 'opencode.agentSettings.v1',
        agentId: 'opencode',
        settings: {
          opencodeBackendMode: {
            schema: { kind: 'enum', values: ['server', 'acp'] },
            default: 'server',
            storageScope: 'account',
          },
          opencodeServerBaseUrl: {
            schema: { kind: 'string' },
            default: '',
            storageScope: 'account',
          },
          opencodeServerBaseUrlByServerIdV1: {
            schema: { kind: 'stringRecord' },
            default: {},
            storageScope: 'account',
          },
        },
        uiSections: [
          expect.objectContaining({
            id: 'opencodeBackendMode',
            fields: [
              expect.objectContaining({ key: 'opencodeBackendMode', kind: 'enum' }),
            ],
          }),
          expect.objectContaining({
            id: 'opencodeServer',
            fields: [
              expect.objectContaining({ key: 'opencodeServerBaseUrl', kind: 'text' }),
            ],
          }),
        ],
      },
        behavior: {
          descriptorId: 'opencode.uiBehavior.v1',
          guidance: { includeInSessionGettingStartedCliExamples: true },
          mcpServers: { supportsDetectedConfigScan: true },
          newSession: {
            transcriptStorageModesByBackendMode: {
              server: ['persisted', 'direct'],
              acp: ['persisted'],
            },
          },
          externalSessions: {
            supportsBackgroundFollow: false,
            browse: {
            order: 30,
            sourceOptions: [
              {
                key: 'opencode:default',
                labelKey: 'externalSessions.browseSourceOpenCodeDefault',
                source: { kind: 'opencodeServer' },
              },
            ],
            compatibleSource: {
              sourceKind: 'opencodeServer',
              optionalFields: ['baseUrl', 'directory'],
            },
          },
        },
        payload: {
          environmentVariables: {
            providerId: 'opencode',
            backendMode: {
              envKey: 'HAPPIER_OPENCODE_BACKEND_MODE',
              settingKey: 'opencodeBackendMode',
              legacyMetadataKey: 'opencodeBackendMode',
              runtimeDescriptorField: 'backendMode',
              defaultValue: 'server',
              values: ['server', 'acp'],
            },
            serverBaseUrl: {
              envKey: 'HAPPIER_OPENCODE_SERVER_URL',
              explicitEnvKey: 'HAPPIER_OPENCODE_SERVER_URL_EXPLICIT',
              settingKey: 'opencodeServerBaseUrl',
              byServerIdSettingKey: 'opencodeServerBaseUrlByServerIdV1',
              legacyMetadataKey: 'opencodeServerBaseUrl',
              legacyExplicitMetadataKey: 'opencodeServerBaseUrlExplicit',
              runtimeDescriptorField: 'serverBaseUrl',
              runtimeDescriptorExplicitField: 'serverBaseUrlExplicit',
              allowedProtocols: ['http:', 'https:'],
              rejectCredentials: true,
              httpLoopbackOnly: true,
              originOnly: true,
            },
          },
        },
      },
      assets: {
        svgIcon: {
          assetId: 'opencode',
          viewBox: '0 0 240 300',
          paths: expect.arrayContaining([
            expect.objectContaining({
              fillToken: 'text.primary',
              fillRule: 'evenodd',
              clipRule: 'evenodd',
            }),
          ]),
        },
      },
    });
  });

  it('is a data-only no-execute descriptor', () => {
    expect(collectNoExecuteViolations(OPENCODE_UI_DESCRIPTOR)).toEqual([]);
    expect(JSON.parse(JSON.stringify(OPENCODE_UI_DESCRIPTOR))).toEqual(OPENCODE_UI_DESCRIPTOR);
  });

  it('keeps the public UI entrypoint data-only', () => {
    const functionExports = Object.entries(openCodeUiEntrypoint)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);

    expect(functionExports).toEqual([]);
    expect(openCodeUiEntrypoint).not.toHaveProperty('OPENCODE_UI_BEHAVIOR_OVERRIDE');
    expect(openCodeUiEntrypoint).not.toHaveProperty('OPENCODE_AGENT_LOGO_SVG_XML');
  });
});
