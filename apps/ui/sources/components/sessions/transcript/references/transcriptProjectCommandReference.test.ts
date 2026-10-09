import { describe, expect, it } from 'vitest';

import {
  readTranscriptProjectCommandAcceptance,
  readTranscriptProjectCommandCall,
} from './transcriptProjectCommandReference';

const accepted = {
  version: 1,
  operationId: 'op-test',
  revision: 1,
  actionId: 'projects.script.run',
  state: 'accepted',
  scope: {
    accountId: 'account',
    machineId: 'hz-build-1',
    sessionId: 'session-1',
  },
  title: 'test',
  createdAt: 1,
  cancellation: 'supported',
  domainRef: {
    kind: 'projectCommand',
    purpose: 'script',
    serverId: 'home',
    machineId: 'hz-build-1',
    workspaceRefId: 'checkout',
    cwd: '/copy',
  },
};
const input = {
  workspace: {
    serverId: 'home',
    machineId: 'devbox',
    workspaceId: 'checkout',
    rootPath: '/src/happier',
  },
  selection: { kind: 'named', name: 'test' },
};

describe('transcript Project command projection', () => {
  it('reads a dedicated Script run tool and its accepted operation from the MCP text result', () => {
    const tool = {
      name: 'mcp__happier__projects_script_run',
      input,
      state: 'completed' as const,
      result: {
        content: [
          { type: 'text', text: JSON.stringify({ operation: accepted }) },
        ],
      },
    };
    expect(readTranscriptProjectCommandCall(tool)).toEqual({
      kind: 'start',
      actionId: 'projects.script.run',
      input,
    });
    expect(readTranscriptProjectCommandAcceptance(tool)?.operationId).toBe(
      'op-test',
    );
  });

  it('reads the generic action_execute form and the executor envelope', () => {
    const tool = {
      name: 'mcp__happier__action_execute',
      input: {
        actionId: 'projects.compute.exec',
        input: { executable: 'yarn' },
      },
      state: 'completed' as const,
      result: {
        ok: true,
        result: {
          operation: { ...accepted, actionId: 'projects.compute.exec' },
        },
      },
    };
    expect(readTranscriptProjectCommandCall(tool)).toMatchObject({
      kind: 'start',
      actionId: 'projects.compute.exec',
      input: { executable: 'yarn' },
    });
    expect(readTranscriptProjectCommandAcceptance(tool)?.operationId).toBe(
      'op-test',
    );
  });

  it('reads a wait on one qualified Action operation, and nothing for other wait targets', () => {
    const target = {
      kind: 'action_operation',
      serverId: 'home',
      machineId: 'hz-build-1',
      operationId: 'op-test',
    };
    expect(
      readTranscriptProjectCommandCall({
        name: 'mcp__happier__wait',
        input: { target, condition: { kind: 'terminal' } },
      }),
    ).toEqual({ kind: 'wait', operationId: 'op-test' });
    expect(
      readTranscriptProjectCommandCall({
        name: 'mcp__happier__wait',
        input: {
          target: { kind: 'session', serverId: 'home', sessionId: 's' },
          condition: { kind: 'idle' },
        },
      }),
    ).toBeNull();
  });

  it('names nothing for a foreign MCP server, a refusal, or a still-running call', () => {
    expect(
      readTranscriptProjectCommandCall({
        name: 'mcp__othervendor__projects_script_run',
        input,
      }),
    ).toBeNull();
    const refused = {
      name: 'mcp__happier__projects_script_run',
      input,
      state: 'completed' as const,
      result: { ok: false, errorCode: 'project_setup_consent_required' },
    };
    expect(readTranscriptProjectCommandAcceptance(refused)).toBeNull();
    expect(
      readTranscriptProjectCommandAcceptance({
        ...refused,
        state: 'running' as const,
        result: { operation: accepted },
      }),
    ).toBeNull();
  });
});
