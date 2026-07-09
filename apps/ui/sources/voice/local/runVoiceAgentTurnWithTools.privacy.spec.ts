import { describe, expect, it } from 'vitest';

import {
  buildToolResultsFollowUpPrompt,
  type LocalVoiceAgentToolResultEntry,
} from './runVoiceAgentTurnWithTools';

function parseFollowUpJson(prompt: string): { toolResults: LocalVoiceAgentToolResultEntry[] } {
  const marker = 'VOICE_TOOL_RESULTS_JSON:\n';
  const start = prompt.indexOf(marker) + marker.length;
  const end = prompt.indexOf('\nVOICE_TOOL_RESULT_INSTRUCTIONS', start);
  return JSON.parse(prompt.slice(start, end === -1 ? undefined : end));
}

describe('runVoiceAgentTurnWithTools follow-up prompt privacy', () => {
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
    });
    expect(promptOn).toContain('req_secret_1');
  });
});
