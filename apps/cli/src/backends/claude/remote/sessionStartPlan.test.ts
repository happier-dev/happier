import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveClaudeRemoteSessionStartPlan } from './sessionStartPlan';
import { getProjectPath } from '../utils/path';

// Only the external filesystem failure is replaced; the start plan and transcript check remain real.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

describe('resolveClaudeRemoteSessionStartPlan', () => {
  it('reports unavailable explicit resume state when transcript inspection fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-unreadable-resume-'));
    const transcriptPath = join(root, 'requested-session.jsonl');
    writeFileSync(transcriptPath, '{}\n');
    const denied = Object.assign(new Error('Transcript access denied'), { code: 'EACCES' });
    const stat = vi.mocked(fs.statSync).mockImplementationOnce(() => { throw denied; });
    try {
      expect(() => resolveClaudeRemoteSessionStartPlan({
        sessionId: 'requested-session', transcriptPath, path: root, claudeConfigDir: null,
      })).toThrow(expect.objectContaining({
        code: 'claude_resume_session_unavailable', providerSessionId: 'requested-session',
      }));
    } finally {
      stat.mockClear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes a copied transcript whose recorded cwd differs from the launch directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-moved-resume-'));
    const path = join(root, 'new-workspace');
    const claudeConfigDir = join(root, 'claude');
    const sessionId = '12345678-1234-1234-1234-123456789abc';
    mkdirSync(path);
    const projectDir = getProjectPath(path, claudeConfigDir);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({
      type: 'user',
      uuid: 'message-1',
      sessionId,
      cwd: join(root, 'old-workspace'),
      message: { role: 'user', content: 'previous conversation' },
    })}\n`);

    try {
      expect(resolveClaudeRemoteSessionStartPlan({
        sessionId,
        transcriptPath: null,
        path,
        claudeConfigDir,
      })).toEqual({ startFrom: sessionId, shouldContinue: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps explicit session id and does not infer continue', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: 'session-1',
        transcriptPath: null,
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: ['--continue'],
      },
      {
        checkSession: () => true,
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => true,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemote',
      },
    );

    expect(result).toEqual({ startFrom: 'session-1', shouldContinue: false });
  });

  it('uses --continue when there is no explicit session id', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: null,
        transcriptPath: null,
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: ['--continue'],
      },
      {
        checkSession: () => true,
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => false,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemote',
      },
    );

    expect(result).toEqual({ startFrom: null, shouldContinue: true });
  });

  it('prefers explicit --resume id over --continue', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: null,
        transcriptPath: null,
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: ['--continue', '--resume', 'resume-123'],
      },
      {
        checkSession: () => true,
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => false,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemoteAgentSdk',
      },
    );

    expect(result).toEqual({ startFrom: 'resume-123', shouldContinue: false });
  });

  it('resolves --resume without id to last known session', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: null,
        transcriptPath: null,
        path: '/tmp/workspace',
        claudeConfigDir: '/tmp/claude',
        claudeArgs: ['--resume'],
      },
      {
        checkSession: () => true,
        findLastSession: () => 'last-session-id',
        hasMaterializedSessionTranscript: () => false,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemoteAgentSdk',
      },
    );

    expect(result).toEqual({ startFrom: 'last-session-id', shouldContinue: false });
  });

  it('fails instead of starting fresh when an explicitly requested resume transcript is unavailable', () => {
    const logDebug = vi.fn();

    expect(() => resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: 'startup-only-session',
        transcriptPath: '/tmp/missing.jsonl',
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: undefined,
      },
      {
        checkSession: vi.fn(() => {
          throw new Error('checkSession should not run when transcript has not materialized');
        }),
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => false,
        logDebug,
        logPrefix: 'claudeRemoteAgentSdk',
      },
    )).toThrow(expect.objectContaining({
      code: 'claude_resume_session_unavailable',
    }));
    expect(logDebug).not.toHaveBeenCalled();
  });

  it('starts fresh without throwing when the session identity owner resolved a provisional id to null', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: null,
        transcriptPath: '/tmp/never-materialized.jsonl',
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: undefined,
      },
      {
        checkSession: () => true,
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => false,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemote',
      },
    );

    expect(result).toEqual({ startFrom: null, shouldContinue: false });
  });

  it('keeps a materialized current session even when deep transcript validation is conservative', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: 'materialized-session',
        transcriptPath: '/tmp/session.jsonl',
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: undefined,
      },
      {
        checkSession: () => false,
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => true,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemote',
      },
    );

    expect(result).toEqual({ startFrom: 'materialized-session', shouldContinue: false });
  });
});
