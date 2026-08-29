import { describe, expect, it } from 'vitest';

import { CLAUDE_UI_DESCRIPTOR } from './descriptor.js';
import { CLAUDE_UI_TRANSLATIONS } from './translations.js';
import { PluginAgentUiBehaviorContributionV2Schema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST } from '../manifest.js';

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

describe('CLAUDE_UI_DESCRIPTOR', () => {
  it('owns Claude UI projection facts including static plan/build modes', () => {
    expect(CLAUDE_UI_DESCRIPTOR).toEqual(expect.objectContaining({
      kind: 'plugin.ui.v1',
      pluginId: PLUGIN_MANIFEST.id,
      agentId: 'claude',
      version: 1,
      display: expect.objectContaining({
        nameKey: 'agentInput.agent.claude',
        subtitleKey: 'profiles.aiBackend.claudeSubtitle',
        connectedService: {
          serviceId: 'anthropic',
          labelKey: 'agentInput.connectedServiceLabel.claude',
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
        picker: expect.objectContaining({
          iconScale: 1.1,
        }),
        icon: { assetId: 'claude' },
      }),
      behavior: expect.objectContaining({
        descriptorId: 'claude.uiBehavior.v1',
        askUserQuestion: {
          dialogs: expect.arrayContaining([
            {
              dialogId: 'trust_folder',
              settingMutation: {
                settingId: { scope: 'account', localId: 'claudeUnifiedTerminalWorkspaceTrust' },
                allowedValues: [
                  'always_trust_happier_workspaces',
                  'always_reject_happier_workspaces',
                ],
              },
              terminalSecondaryAction: {
                kind: 'openAttachedTerminal',
                labelKey: 'tools.askUserQuestion.attachedTerminalNotice.openTerminal',
                descriptionKey: 'tools.askUserQuestion.attachedTerminalNotice.description',
              },
            },
            expect.objectContaining({
              dialogId: 'resume_choice',
              settingMutation: {
                settingId: { scope: 'account', localId: 'claudeUnifiedTerminalResumeChoice' },
                allowedValues: ['resume_from_summary', 'resume_full_session'],
              },
            }),
            expect.objectContaining({
              dialogId: 'unrecognized_confirmation',
              terminalNotice: {
                headerKey: 'tools.askUserQuestion.attachedTerminalNotice.header',
                questionKey: 'tools.askUserQuestion.attachedTerminalNotice.question',
              },
            }),
          ]),
        },
        externalSessions: expect.objectContaining({
          browse: {
            order: 20,
            sourceOptions: [
              {
                key: 'claude:default',
                labelKey: 'externalSessions.browseSourceClaudeDefault',
                source: { kind: 'claudeConfig' },
              },
            ],
            compatibleSource: {
              sourceKind: 'claudeConfig',
              optionalFields: ['configDir', 'projectId'],
            },
            linkEnsureRequestExtras: {
              sourceFromCandidate: {
                sourceKind: 'claudeConfig',
                optionalFields: ['configDir', 'projectId'],
              },
            },
          },
        }),
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
    expect(CLAUDE_UI_DESCRIPTOR).not.toHaveProperty('settings');
  });

  it('is a data-only no-execute descriptor', () => {
    expect(collectNoExecuteViolations(CLAUDE_UI_DESCRIPTOR)).toEqual([]);
    expect(JSON.parse(JSON.stringify(CLAUDE_UI_DESCRIPTOR))).toEqual(CLAUDE_UI_DESCRIPTOR);
  });

  it('authors Session behavior through the same public grammar as an external Agent', () => {
    expect(PluginAgentUiBehaviorContributionV2Schema.safeParse({
      session: CLAUDE_UI_DESCRIPTOR.session,
    }).success).toBe(true);
  });

  it('ships every teammate-details translation key in every projected locale', () => {
    const detailsSlot = CLAUDE_UI_DESCRIPTOR.components?.slots?.find(
      (slot) => slot.slot === 'sessionSubagents.teammateDetailsTab',
    );
    if (!detailsSlot || !('tab' in detailsSlot)) {
      throw new Error('Claude teammate details slot is missing');
    }
    const keys = [detailsSlot.tab.titleKey, detailsSlot.tab.subtitleKey]
      .filter((key): key is string => typeof key === 'string');

    expect(Object.keys(CLAUDE_UI_TRANSLATIONS)).toContain('de');
    for (const messages of Object.values(CLAUDE_UI_TRANSLATIONS)) {
      expect(keys.every((key) => typeof (messages as Readonly<Record<string, string>>)[key] === 'string'))
        .toBe(true);
    }
  });
});
