import { describe, expect, it } from 'vitest';
import { parseVoiceToolResultsFollowUp } from '@happier-dev/protocol';

import {
  buildToolResultsFollowUpPrompt,
  type LocalVoiceAgentToolResultEntry,
} from './runVoiceAgentTurnWithTools';

function parseFollowUpJson(prompt: string): { toolResults: LocalVoiceAgentToolResultEntry[] } {
  const parsed = parseVoiceToolResultsFollowUp(prompt);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { toolResults?: unknown }).toolResults)) {
    throw new Error('Expected canonical voice tool-results follow-up payload');
  }
  return parsed as { toolResults: LocalVoiceAgentToolResultEntry[] };
}

describe('runVoiceAgentTurnWithTools follow-up prompt privacy', () => {
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

  it('strips pending permission-request identifiers when sharePermissionRequests is false', () => {
    const toolResults: LocalVoiceAgentToolResultEntry[] = [
      {
        t: 'getSessionActivity',
        args: { sessionId: 's1' },
        result: {
          ok: true,
          sessionId: 's1',
          permissionRequestIds: ['req_secret_1', 'req_secret_2'],
        },
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
    const offResult = parsedOff.toolResults[0]!.result as { permissionRequestIds?: unknown };
    expect(offResult.permissionRequestIds).toBeUndefined();

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
