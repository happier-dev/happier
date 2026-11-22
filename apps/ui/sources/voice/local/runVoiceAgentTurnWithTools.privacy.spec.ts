import { describe, expect, it } from 'vitest';
import {
  getActionSpec} from '@happier-dev/protocol/actions/actionSpecs';
import {
  parseVoiceToolResultsFollowUp} from '@happier-dev/protocol/voice/toolResultsChannel';
import {
  projectSessionActivityCompatibilityV1,
} from '@happier-dev/protocol/sessions/awareness/action';

import { buildToolResultsFollowUpPrompt } from '@/voice/context/buildVoiceToolResultsFollowUp';
import type { LocalVoiceAgentToolResultEntry } from '@/voice/tools/localVoiceEffectOutcomeCustody';

function parseFollowUpJson(prompt: string): { toolResults: LocalVoiceAgentToolResultEntry[] } {
  const parsed = parseVoiceToolResultsFollowUp(prompt);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { toolResults?: unknown }).toolResults)) {
    throw new Error('Expected canonical voice tool-results follow-up payload');
  }
  return parsed as { toolResults: LocalVoiceAgentToolResultEntry[] };
}

describe('runVoiceAgentTurnWithTools follow-up prompt privacy', () => {
  it('includes the failure instruction when another Action result is held', () => {
    const action = { t: 'action_execute', args: { actionId: 'daemon.filesystem.copy', input: {} } };
    const prompt = buildToolResultsFollowUpPrompt([
      { ...action, result: { ok: false, errorCode: 'approval_result_held', error: 'approval_result_held' } },
      { ...action, result: { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' } },
    ], { shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: false });

    expect(parseFollowUpJson(prompt).toolResults.map(entry => entry.result)).toMatchObject([
      { ok: false, errorCode: 'approval_result_held' },
      { ok: false, errorCode: 'invalid_action_output' },
    ]);
    expect(prompt).toContain('At least one action failed.');
  });

  it('derives the Local summary from the privacy-projected result rather than a stripped target label', () => {
    const prompt = buildToolResultsFollowUpPrompt([{ t: 'spawnSession', args: {},
      result: { ok: true, target: { label: 'Private Session title' } } }], {
      shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: false,
    });
    expect(prompt).not.toContain('Private Session title');
    expect(parseFollowUpJson(prompt).toolResults[0]?.result).not.toHaveProperty('summary');
  });

  it('withdraws a previously generated Local summary when summary sharing changes before delivery', () => {
    const prefs = { shareFilePaths: false, shareSessionSummary: true, sharePermissionRequests: false };
    const first = parseFollowUpJson(buildToolResultsFollowUpPrompt([{ t: 'spawnSession', args: {},
      result: { ok: true, target: { label: 'Private Session title' } } }], prefs));
    expect(JSON.stringify(first)).toContain('Private Session title');
    const prompt = buildToolResultsFollowUpPrompt(first.toolResults, { ...prefs, shareSessionSummary: false });
    expect(prompt).not.toContain('Private Session title');
  });

  it.each(['outcomeUnknown', 'pending', 'approval_request_created'])('does not label a %s outcome as completed success', status => {
    const prompt = buildToolResultsFollowUpPrompt([{ t: 'sendSessionMessage', args: {}, result: { ok: true, status } }], {
      shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: false, shareDeviceInventory: false,
    });
    expect(prompt).not.toContain('All actions succeeded');
    expect(parseFollowUpJson(prompt).toolResults[0]?.result).toMatchObject({ ok: true, status });
  });

  it('preserves owner-selected catalogs, paging facts and long valid text without a Voice volume policy', () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ modelId: `model-${index}`, label: `Model ${index}` }));
    const longText = 'Valid response detail '.repeat(30);
    const prompt = buildToolResultsFollowUpPrompt([
      { t: 'listAgentModels', args: { limit: 12 }, result: { items, hasMore: true, nextCursor: 'catalog-page-2', totalCount: 24 } },
      { t: 'listAgentBackends', args: {}, result: { items: items.map((item, index) => ({
        agentId: `agent-${index}`, targetKey: `backend:agent-${index}`, label: item.label,
      })), hasMore: false } },
      { t: 'listRecentPaths', args: {}, result: { items: Array.from({ length: 12 }, () => longText),
        uiConnectedService: 'private', flavorAliases: ['private-alias'] } },
    ], { shareFilePaths: true, shareSessionSummary: true, sharePermissionRequests: true, shareDeviceInventory: true });
    const parsed = parseFollowUpJson(prompt);
    expect(parsed.toolResults[0]?.result).toMatchObject({ items, hasMore: true, nextCursor: 'catalog-page-2', totalCount: 24 });
    expect(parsed.toolResults[1]?.result).toMatchObject({ items: expect.any(Array), hasMore: false });
    expect((parsed.toolResults[1]?.result as { items: unknown[] }).items).toHaveLength(12);
    expect(parsed.toolResults[2]?.result).toEqual({ items: Array.from({ length: 12 }, () => longText) });
  });
  it('preserves exact Provider connection identity in compact model-list follow-up results', () => {
    const prompt = buildToolResultsFollowUpPrompt([{
      t: 'listAgentModels',
      args: { agentId: 'claude', machineId: 'm1' },
      result: {
        source: 'preflight',
        supportsFreeform: true,
        items: [{
          modelId: 'provider-model',
          label: 'Provider model',
          providerConnectionId: 'pc_work',
          providerName: 'Gateway · Work',
        }],
      },
    }], {
      shareFilePaths: false,
      shareSessionSummary: false,
      sharePermissionRequests: false,
      shareDeviceInventory: true,
    });

    const parsed = parseFollowUpJson(prompt);
    expect((parsed.toolResults[0] as any).result.items).toEqual([{
      modelId: 'provider-model',
      label: 'Provider model',
      providerConnectionId: 'pc_work',
      providerName: 'Gateway · Work',
    }]);
  });

  it('redacts file-path-like data in raw tool results when shareFilePaths is false', () => {
    const toolResults: LocalVoiceAgentToolResultEntry[] = [
      {
        t: 'listRecentPaths',
        args: { cwd: '/Users/leeroy/Documents/secret-project' },
        result: {
          ok: true,
          items: [{ label: 'apps/ui/sources/voice/secretFile.ts', path: '/Users/leeroy/secret' }],
        },
      },
    ];

    const prompt = buildToolResultsFollowUpPrompt(toolResults, {
      shareFilePaths: false,
      shareSessionSummary: true,
      sharePermissionRequests: true,
      shareDeviceInventory: true,
    });

    expect(prompt).not.toContain('/Users/leeroy');
    expect(prompt).not.toContain('apps/ui/sources/voice/secretFile.ts');
    expect(prompt).toContain('<path_redacted>');
  });

  it('keeps raw file paths when shareFilePaths is true', () => {
    const toolResults: LocalVoiceAgentToolResultEntry[] = [
      {
        t: 'listRecentPaths',
        args: {},
        result: { ok: true, items: [{ label: 'apps/ui/sources/voice/file.ts' }] },
      },
    ];

    const prompt = buildToolResultsFollowUpPrompt(toolResults, {
      shareFilePaths: true,
      shareSessionSummary: true,
      sharePermissionRequests: true,
      shareDeviceInventory: true,
    });

    expect(prompt).toContain('apps/ui/sources/voice/file.ts');
  });

  it('does not synthesize a spoken session summary when shareSessionSummary is false', () => {
    const toolResults: LocalVoiceAgentToolResultEntry[] = [
      {
        t: 'listSessions',
        args: {},
        result: {
          ok: true,
          sessions: [{ id: 'sess_a' }],
          nextCursor: null,
        },
      },
    ];

    const prompt = buildToolResultsFollowUpPrompt(toolResults, {
      shareFilePaths: true,
      shareSessionSummary: false,
      sharePermissionRequests: true,
      shareDeviceInventory: true,
    });

    const parsed = parseFollowUpJson(prompt);
    const entry = parsed.toolResults[0]! as { result?: Record<string, unknown> };
    expect(entry.result?.summary).toBeUndefined();
  });

  it('strips raw session titles from openSession / sessionReference / spawnSession results when shareSessionSummary is false', () => {
    const toolResults: LocalVoiceAgentToolResultEntry[] = [
      {
        t: 'openSession',
        args: { sessionId: 's1' },
        result: {
          ok: true,
          status: 'opened',
          sessionId: 's1',
          session: { id: 's1', title: 'Stored Summary Alpha', locationLabel: 'secret-repo', serverName: 'Box' },
        },
      },
      {
        t: 'setTrackedSessions',
        args: {},
        result: {
          ok: true,
          status: 'ok',
          sessionIds: ['s2'],
          sessions: [{ id: 's2', title: 'Stored Summary Beta' }],
        },
      },
      {
        t: 'spawnSession',
        args: {},
        result: {
          ok: true,
          session: { id: 's3', title: 'Stored Summary Gamma' },
          target: { label: 'work-dir' },
        },
      },
    ];

    const prompt = buildToolResultsFollowUpPrompt(toolResults, {
      shareFilePaths: true,
      shareSessionSummary: false,
      sharePermissionRequests: true,
      shareDeviceInventory: true,
    });

    expect(prompt).not.toContain('Stored Summary Alpha');
    expect(prompt).not.toContain('Stored Summary Beta');
    expect(prompt).not.toContain('Stored Summary Gamma');

    const parsed = parseFollowUpJson(prompt);
    const open = parsed.toolResults[0]!.result as { session?: Record<string, unknown> };
    expect(open.session?.title).toBeUndefined();
    expect(open.session?.id).toBe('s1');
    const tracked = parsed.toolResults[1]!.result as { sessions?: Array<Record<string, unknown>> };
    expect(tracked.sessions?.[0]?.title).toBeUndefined();
    expect(tracked.sessions?.[0]?.id).toBe('s2');
    const spawn = parsed.toolResults[2]!.result as { session?: Record<string, unknown> };
    expect(spawn.session?.title).toBeUndefined();
  });

  it('keeps raw session titles when shareSessionSummary is true', () => {
    const toolResults: LocalVoiceAgentToolResultEntry[] = [
      {
        t: 'openSession',
        args: { sessionId: 's1' },
        result: {
          ok: true,
          status: 'opened',
          sessionId: 's1',
          session: { id: 's1', title: 'Stored Summary Alpha' },
        },
      },
    ];

    const prompt = buildToolResultsFollowUpPrompt(toolResults, {
      shareFilePaths: true,
      shareSessionSummary: true,
      sharePermissionRequests: true,
      shareDeviceInventory: true,
    });

    expect(prompt).toContain('Stored Summary Alpha');
    const parsed = parseFollowUpJson(prompt);
    const open = parsed.toolResults[0]!.result as { session?: Record<string, unknown> };
    expect(open.session?.title).toBe('Stored Summary Alpha');
  });

  it('keeps current UI presentation labels while retaining path redaction when session-summary sharing is off', () => {
    const prompt = buildToolResultsFollowUpPrompt([{
      t: 'readCurrentUiContext',
      args: {},
      result: {
        navigation: { title: 'Triage issue' },
        entity: { label: 'happier#123' },
        commands: [{ id: 'current-ui-command:1', title: 'Open issue #124' }],
        detail: { path: '/Users/leeroy/private-worktree' },
      },
    }], {
      shareFilePaths: false,
      shareSessionSummary: false,
      sharePermissionRequests: true,
      shareDeviceInventory: true,
    });

    expect(prompt).toContain('Triage issue');
    expect(prompt).toContain('happier#123');
    expect(prompt).toContain('Open issue #124');
    expect(prompt).not.toContain('/Users/leeroy/private-worktree');
    expect(prompt).toContain('<path_redacted>');
  });

  it('does not echo Action input or current-UI command ids in the provider result channel', () => {
    const invokeActionTool = getActionSpec('action.invoke').bindings?.voiceClientToolName;
    const invokeCurrentUiCommandTool = getActionSpec('ui.current_context.command.invoke')
      .bindings?.voiceClientToolName;
    if (!invokeActionTool || !invokeCurrentUiCommandTool) {
      throw new Error('Expected canonical Voice tool bindings');
    }

    const prompt = buildToolResultsFollowUpPrompt([
      {
        t: invokeActionTool,
        args: {
          action: { pluginId: 'acme.triage', localId: 'comment' },
          input: { body: 'private comment body' },
        },
        result: {
          ok: false,
          errorCode: 'stale_surface',
          errorMessage: 'raw provider error: private-token',
          result: {
            credential: { token: 'private-token' },
            providerId: 'private-provider',
            connectionId: 'private-connection',
            originalInput: { body: 'private comment body' },
            error: { message: 'raw provider error' },
          },
        },
      },
      {
        t: invokeCurrentUiCommandTool,
        args: { commandId: 'current-ui-command:private-selection' },
        result: {
          ok: true,
          result: {
            credential: { token: 'private-command-token' },
            providerId: 'private-command-provider',
            connectionId: 'private-command-connection',
            commandId: 'current-ui-command:private-selection',
            error: { message: 'raw current UI command error' },
          },
        },
      },
    ], {
      shareFilePaths: true,
      shareSessionSummary: true,
      sharePermissionRequests: true,
      shareDeviceInventory: true,
    });

    expect(prompt).not.toContain('private comment body');
    expect(prompt).not.toContain('current-ui-command:private-selection');
    expect(prompt).not.toContain('private-token');
    expect(prompt).not.toContain('private-provider');
    expect(prompt).not.toContain('private-connection');
    expect(prompt).not.toContain('raw provider error');
    expect(prompt).not.toContain('private-command-token');
    expect(prompt).not.toContain('private-command-provider');
    expect(prompt).not.toContain('private-command-connection');
    expect(prompt).not.toContain('raw current UI command error');
    const parsed = parseFollowUpJson(prompt);
    expect(parsed.toolResults.map((entry) => entry.args)).toEqual([null, null]);
    expect(parsed.toolResults.map((entry) => entry.result)).toEqual([
      {
        ok: false,
        errorCode: 'stale_surface',
        errorMessage: 'stale_surface',
      },
      { ok: true },
    ]);
  });

  it('strips pending permission-request state when sharePermissionRequests is false', () => {
    const toolResults: LocalVoiceAgentToolResultEntry[] = [
      {
        t: 'getSessionActivity',
        args: { sessionId: 's1' },
        // The exact released digest the Action answers with. Identities and the requirement
        // itself are both withheld: a surviving `permissionRequired` would still tell the model
        // the user is being asked for permission.
        result: projectSessionActivityCompatibilityV1({
          awareness: {
            v: 1, sessionId: 's1', lifecycle: 'active', runtime: 'waiting', freshness: 'live',
            operational: { primary: 'permission_required', reasons: ['permission_required'] },
            encryption: 'plain', availability: 'complete',
          },
          facts: {
            presence: 'online', active: true, thinking: false, updatedAt: 123,
            permissionRequestIds: ['req_secret_1', 'req_secret_2'],
          },
        }),
      },
    ];

    const promptOff = buildToolResultsFollowUpPrompt(toolResults, {
      shareFilePaths: true,
      shareSessionSummary: true,
      sharePermissionRequests: false,
      shareDeviceInventory: true,
    });
    expect(promptOff).not.toContain('req_secret_1');
    expect(promptOff).not.toContain('req_secret_2');
    const parsedOff = parseFollowUpJson(promptOff);
    const offResult = parsedOff.toolResults[0]!.result as {
      permissionRequestIds?: unknown;
      permissionRequired?: unknown;
      actionRequired?: unknown;
      blocked?: unknown;
    };
    expect(offResult.permissionRequestIds).toBeUndefined();
    expect(offResult).toMatchObject({ permissionRequired: false, actionRequired: false, blocked: false });

    const promptOn = buildToolResultsFollowUpPrompt(toolResults, {
      shareFilePaths: true,
      shareSessionSummary: true,
      sharePermissionRequests: true,
      shareDeviceInventory: true,
    });
    expect(promptOn).toContain('req_secret_1');
  });

  it('drops every completed inventory-family result when inventory sharing is disabled before the provider follow-up', () => {
    const inventoryToolNames = [
      'listRecentPaths',
      'listMachines',
      'listServers',
      'listReviewEngines',
      'listAgentBackends',
      'listAgentModels',
    ] as const;
    const prompt = buildToolResultsFollowUpPrompt(inventoryToolNames.map((toolName) => ({
      t: toolName,
      args: { lookup: `${toolName}_args_secret` },
      result: {
        ok: true,
        items: [{ id: `${toolName}_result_secret`, label: `${toolName} private inventory` }],
      },
    })), {
      shareFilePaths: true,
      shareSessionSummary: true,
      sharePermissionRequests: true,
      shareDeviceInventory: false,
    });

    expect(prompt).not.toContain('_args_secret');
    expect(prompt).not.toContain('_result_secret');
    expect(prompt).not.toContain('private inventory');
    const parsed = parseFollowUpJson(prompt);
    expect(parsed.toolResults).toEqual(inventoryToolNames.map((toolName) => ({
      t: toolName,
      args: null,
      result: {
        ok: false,
        errorCode: 'privacy_disabled',
        errorMessage: 'privacy_disabled',
      },
    })));
  });

  it('drops a completed transcript result when recent-message sharing is disabled before the provider follow-up', () => {
    const prompt = buildToolResultsFollowUpPrompt([{
      t: 'getSessionTranscript',
      args: { sessionId: 's1' },
      result: {
        ok: true,
        items: [{ role: 'user', text: 'private transcript message' }],
      },
    }], {
      shareFilePaths: true,
      shareSessionSummary: true,
      sharePermissionRequests: true,
      shareDeviceInventory: true,
      shareRecentMessages: false,
    });

    expect(prompt).not.toContain('private transcript message');
    const parsed = parseFollowUpJson(prompt);
    expect(parsed.toolResults[0]).toEqual({
      t: 'getSessionTranscript',
      args: null,
      result: {
        ok: false,
        errorCode: 'privacy_disabled',
        errorMessage: 'privacy_disabled',
      },
    });
  });
});
