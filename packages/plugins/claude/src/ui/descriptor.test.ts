import { describe, expect, it } from 'vitest';

import { CLAUDE_UI_DESCRIPTOR } from './descriptor.js';

const FORBIDDEN_NO_EXECUTE_KEYS = new Set([
  'projection',
  'importName',
  'source',
  'label',
  'uiBehaviorOverride',
  'sessionProviderBehavior',
  'messageMetaOverride',
  'providerSettings',
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
    if (typeof child === 'string' && /#[0-9a-fA-F]{3,8}\b/.test(child)) {
      violations.push(`${path}.${key}: raw color literal`);
    }
    return [...violations, ...collectNoExecuteViolations(child, `${path}.${key}`)];
  });
}

describe('CLAUDE_UI_DESCRIPTOR', () => {
  it('owns Claude UI projection facts including static plan/build modes', () => {
    expect(CLAUDE_UI_DESCRIPTOR).toEqual(expect.objectContaining({
      kind: 'plugin.ui.v1',
      pluginId: 'claude',
      agentId: 'claude',
      version: 1,
      display: expect.objectContaining({
        nameKey: 'agentInput.agent.claude',
        subtitleKey: 'profiles.aiBackend.claudeSubtitle',
        connectedService: {
          serviceId: 'anthropic',
          labelKey: 'agentInput.agent.claude',
          connectRoute: '/(app)/settings/connect/claude',
        },
        permissions: {
          modeGroup: 'claude',
          promptProtocol: 'claude',
        },
        sessionModes: {
          staticOptions: [
            {
              id: 'default',
              nameKey: 'agentInput.mode.build',
              descriptionKey: 'agentInput.mode.buildDescription',
            },
            {
              id: 'plan',
              nameKey: 'agentInput.mode.plan',
              descriptionKey: 'agentInput.mode.planDescription',
            },
          ],
        },
        toolRendering: {
          hideUnknownToolsByDefault: false,
        },
        icon: { assetId: 'claude' },
      }),
      settings: expect.objectContaining({
        kind: 'providerSettings.v1',
        descriptorId: 'claude.providerSettings.v1',
        providerId: 'claude',
        settings: expect.objectContaining({
          claudeRemoteAgentSdkEnabled: expect.objectContaining({
            schema: { kind: 'boolean' },
            default: true,
          }),
          claudeUnifiedTerminalHost: expect.objectContaining({
            schema: { kind: 'enum', values: ['auto', 'tmux', 'zellij'] },
            default: 'auto',
          }),
          claudeRemoteSettingSourcesV2: expect.objectContaining({
            schema: { kind: 'array', element: { kind: 'enum', values: ['user', 'project', 'local'] }, max: 3 },
            default: ['user', 'project', 'local'],
          }),
          claudeRemoteMaxThinkingTokens: expect.objectContaining({
            schema: { kind: 'number', int: true, min: 1, nullable: true },
            default: null,
          }),
        }),
      }),
      behavior: expect.objectContaining({
        descriptorId: 'claude.uiBehavior.v1',
      }),
      session: expect.objectContaining({
        providerBehavior: {
          kind: 'session.providerBehavior.v1',
          agentTeam: {
            kind: 'session.agentTeamBehavior.v1',
            snapshotKey: 'claudeTeam',
            providerLabel: 'Claude',
            flavorAliases: ['claude'],
            tools: {
              teamCreate: ['AgentTeamCreate', 'TeamCreate'],
              teamDelete: ['AgentTeamDelete', 'TeamDelete'],
              teamSendMessage: ['AgentTeamSendMessage', 'TeamSendMessage'],
              subagentSpawn: ['Agent', 'Task'],
              activeTeamFallbackSubagentSpawn: ['Agent'],
              configMutation: ['Edit', 'Write'],
            },
            configTeamPath: {
              rootDirectory: '.claude',
              teamsDirectory: 'teams',
              filename: 'config.json',
            },
            lifecycleEvents: {
              ignoreActivityPreview: ['idle_notification', 'shutdown_approved'],
              shutdownApproved: 'shutdown_approved',
            },
          },
        },
        providerBehaviorDescriptorId: 'claude.sessionProviderBehavior.v1',
        visibleMessages: {
          kind: 'session.visibleMessages.v1',
          subagentKinds: ['agent_team_member'],
          fallbackToolNames: ['Agent', 'Task'],
          excludeJsonEventTypes: ['idle_notification', 'shutdown_approved'],
        },
      }),
      message: expect.objectContaining({
        metaOverrides: [
          {
            id: 'reasoning-effort',
            targetKey: 'reasoningEffort',
            value: {
              kind: 'sessionConfigOptionOverride',
              key: 'reasoning_effort',
            },
            normalize: 'trimLowercase',
          },
        ],
      }),
      assets: {
        svgIcon: { assetId: 'claude' },
      },
    }));
  });

  it('is a data-only no-execute descriptor', () => {
    expect(collectNoExecuteViolations(CLAUDE_UI_DESCRIPTOR)).toEqual([]);
    expect(JSON.parse(JSON.stringify(CLAUDE_UI_DESCRIPTOR))).toEqual(CLAUDE_UI_DESCRIPTOR);
  });
});
