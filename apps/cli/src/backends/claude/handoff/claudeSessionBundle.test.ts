import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { exportClaudeSessionBundle } from './exportClaudeSessionBundle';
import { importClaudeSessionBundle } from './importClaudeSessionBundle';

describe('claude session handoff bundle', () => {
  it('exports the transcript from the explicit transcript path when available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-export-'));
    const transcriptPath = join(root, 'source.jsonl');
    await writeFile(transcriptPath, '{"type":"user"}\n', 'utf8');

    const result = await exportClaudeSessionBundle({
      metadata: {
        path: '/repo',
        claudeSessionId: 'claude_session_1',
        claudeTranscriptPath: transcriptPath,
      },
      remoteSessionId: 'claude_session_1',
      env: {},
    });

    expect(result).toEqual({
      providerId: 'claude',
      remoteSessionId: 'claude_session_1',
      transcriptBase64: Buffer.from('{"type":"user"}\n', 'utf8').toString('base64'),
    });
  });

  it('falls back to the fake Claude transcript log when no transcript path metadata is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-export-fake-'));
    const transcriptPath = join(root, 'fake-claude.jsonl');
    await writeFile(transcriptPath, '{"type":"assistant"}\n', 'utf8');

    const result = await exportClaudeSessionBundle({
      metadata: {
        path: join(root, 'workspace'),
        claudeSessionId: 'claude_session_fake',
      },
      remoteSessionId: 'claude_session_fake',
      env: {
        HAPPIER_E2E_FAKE_CLAUDE_LOG: transcriptPath,
      },
    });

    expect(result).toEqual({
      providerId: 'claude',
      remoteSessionId: 'claude_session_fake',
      transcriptBase64: Buffer.from('{"type":"assistant"}\n', 'utf8').toString('base64'),
    });
  });

  it('resolves transcript heuristics from HAPPIER_CLAUDE_CONFIG_DIR when CLAUDE_CONFIG_DIR is not set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-export-happier-config-'));
    const workspacePath = join(root, 'workspace');
    const claudeConfigDir = join(root, '.claude-source');
    const projectId = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
    const transcriptPath = join(claudeConfigDir, 'projects', projectId, 'claude_session_env.jsonl');
    await mkdir(join(claudeConfigDir, 'projects', projectId), { recursive: true });
    await writeFile(transcriptPath, '{"type":"assistant","text":"from-happier-config"}\n', 'utf8');

    const result = await exportClaudeSessionBundle({
      metadata: {
        path: workspacePath,
        claudeSessionId: 'claude_session_env',
      },
      remoteSessionId: 'claude_session_env',
      env: {
        HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
    });

    expect(result).toEqual({
      providerId: 'claude',
      remoteSessionId: 'claude_session_env',
      transcriptBase64: Buffer.from('{"type":"assistant","text":"from-happier-config"}\n', 'utf8').toString('base64'),
    });
  });

  it('prefers the recorded direct-session source config dir and project id when exporting a linked Claude direct session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-export-direct-source-'));
    const workspacePath = join(root, 'workspace');
    const configDir = join(root, '.claude-direct');
    const transcriptPath = join(configDir, 'projects', 'proj-direct-linked', 'claude_session_direct.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-direct-linked'), { recursive: true });
    await writeFile(transcriptPath, '{"type":"assistant","text":"from-direct-source"}\n', 'utf8');

    const result = await exportClaudeSessionBundle({
      metadata: {
        path: workspacePath,
        claudeSessionId: 'claude_session_direct',
        directSessionV1: {
          source: {
            kind: 'claudeConfig',
            configDir,
            projectId: 'proj-direct-linked',
          },
        },
      },
      remoteSessionId: 'claude_session_direct',
      env: {},
    });

    expect(result).toEqual({
      providerId: 'claude',
      remoteSessionId: 'claude_session_direct',
      transcriptBase64: Buffer.from('{"type":"assistant","text":"from-direct-source"}\n', 'utf8').toString('base64'),
    });
  });

  it('prefers the current direct-session transcript over a stale explicit transcript path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-export-direct-preferred-'));
    const workspacePath = join(root, 'workspace');
    const staleTranscriptPath = join(root, 'stale.jsonl');
    const configDir = join(root, '.claude-direct');
    const liveTranscriptPath = join(configDir, 'projects', 'proj-direct-live', 'claude_session_direct.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-direct-live'), { recursive: true });
    await writeFile(staleTranscriptPath, '{"type":"assistant","text":"stale-explicit"}\n', 'utf8');
    await writeFile(liveTranscriptPath, '{"type":"assistant","text":"live-direct"}\n', 'utf8');

    const result = await exportClaudeSessionBundle({
      metadata: {
        path: workspacePath,
        claudeSessionId: 'claude_session_direct',
        claudeTranscriptPath: staleTranscriptPath,
        directSessionV1: {
          source: {
            kind: 'claudeConfig',
            configDir,
            projectId: 'proj-direct-live',
          },
        },
      },
      remoteSessionId: 'claude_session_direct',
      env: {},
    });

    expect(result).toEqual({
      providerId: 'claude',
      remoteSessionId: 'claude_session_direct',
      transcriptBase64: Buffer.from('{"type":"assistant","text":"live-direct"}\n', 'utf8').toString('base64'),
    });
  });

  it('imports the transcript into the target claude project path and returns resume metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-import-'));
    const targetPath = join(root, 'workspace');
    await mkdir(targetPath, { recursive: true });

    const result = await importClaudeSessionBundle({
      bundle: {
        providerId: 'claude',
        remoteSessionId: 'claude_session_1',
        transcriptBase64: Buffer.from('{"type":"assistant"}\n', 'utf8').toString('base64'),
      },
      targetPath,
      env: {
        CLAUDE_CONFIG_DIR: join(root, '.claude-target'),
      },
    });

    expect(result.remoteSessionId).toBe('claude_session_1');
    const projectId = targetPath.replace(/[^a-zA-Z0-9-]/g, '-');
    expect(result.directSource).toEqual({
      kind: 'claudeConfig',
      configDir: join(root, '.claude-target'),
      projectId,
    });
    expect(result.resume).toEqual({
      directory: targetPath,
      agent: 'claude',
      resume: 'claude_session_1',
      environmentVariables: {
        CLAUDE_CONFIG_DIR: join(root, '.claude-target'),
        HAPPIER_STARTUP_TRANSCRIPT_CATCH_UP_LOOKBACK_MS: '60000',
      },
      transcriptStorage: 'direct',
      approvedNewDirectoryCreation: true,
    });

    const importedPath = join(root, '.claude-target', 'projects', projectId, 'claude_session_1.jsonl');
    await expect(readFile(importedPath, 'utf8')).resolves.toBe('{"type":"assistant"}\n');
  });

  it('supports persisted resume plans when the handoff keeps persisted transcript storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-import-persisted-'));
    const targetPath = join(root, 'workspace');
    await mkdir(targetPath, { recursive: true });

    const result = await importClaudeSessionBundle({
      bundle: {
        providerId: 'claude',
        remoteSessionId: 'claude_session_2',
        transcriptBase64: Buffer.from('{"type":"assistant"}\n', 'utf8').toString('base64'),
      },
      targetPath,
      env: {},
      sessionStorageMode: 'persisted',
    });

    expect(result.resume).toMatchObject({
      directory: targetPath,
      agent: 'claude',
      resume: 'claude_session_2',
      transcriptStorage: 'persisted',
      approvedNewDirectoryCreation: true,
    });
  });

  it('uses HAPPIER_CLAUDE_CONFIG_DIR for target import when CLAUDE_CONFIG_DIR is unset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-import-happier-config-'));
    const targetPath = join(root, 'workspace');
    const configDir = join(root, '.claude-target-override');
    await mkdir(targetPath, { recursive: true });

    const result = await importClaudeSessionBundle({
      bundle: {
        providerId: 'claude',
        remoteSessionId: 'claude_session_happier_override',
        transcriptBase64: Buffer.from('{"type":"assistant","text":"override"}\n', 'utf8').toString('base64'),
      },
      targetPath,
      env: {
        HAPPIER_CLAUDE_CONFIG_DIR: configDir,
      },
    });

    expect(result.directSource).toEqual({
      kind: 'claudeConfig',
      configDir,
      projectId: targetPath.replace(/[^a-zA-Z0-9-]/g, '-'),
    });
      expect(result.resume).toEqual({
        directory: targetPath,
        agent: 'claude',
        resume: 'claude_session_happier_override',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: configDir,
          HAPPIER_STARTUP_TRANSCRIPT_CATCH_UP_LOOKBACK_MS: '60000',
        },
        transcriptStorage: 'direct',
        approvedNewDirectoryCreation: true,
      });

    const projectId = targetPath.replace(/[^a-zA-Z0-9-]/g, '-');
    const importedPath = join(configDir, 'projects', projectId, 'claude_session_happier_override.jsonl');
    await expect(readFile(importedPath, 'utf8')).resolves.toBe('{"type":"assistant","text":"override"}\n');
  });

  it('falls back to an explicit HOME-based Claude config dir when no override is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-import-home-fallback-'));
    const targetPath = join(root, 'workspace');
    await mkdir(targetPath, { recursive: true });

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await importClaudeSessionBundle({
        bundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_home_fallback',
          transcriptBase64: Buffer.from('{"type":"assistant","text":"home-fallback"}\n', 'utf8').toString('base64'),
        },
        targetPath,
        env: {},
      });

      expect(result.directSource).toEqual({
        kind: 'claudeConfig',
        configDir: join(root, '.claude'),
        projectId: targetPath.replace(/[^a-zA-Z0-9-]/g, '-'),
      });
      expect(result.resume.environmentVariables).toEqual({
        CLAUDE_CONFIG_DIR: join(root, '.claude'),
        HAPPIER_STARTUP_TRANSCRIPT_CATCH_UP_LOOKBACK_MS: '60000',
      });

      const projectId = targetPath.replace(/[^a-zA-Z0-9-]/g, '-');
      const importedPath = join(root, '.claude', 'projects', projectId, 'claude_session_home_fallback.jsonl');
      await expect(readFile(importedPath, 'utf8')).resolves.toBe('{"type":"assistant","text":"home-fallback"}\n');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('rejects remote session ids that contain path separators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-import-invalid-id-'));
    const targetPath = join(root, 'workspace');
    await mkdir(targetPath, { recursive: true });

    await expect(importClaudeSessionBundle({
      bundle: {
        providerId: 'claude',
        remoteSessionId: '../escape',
        transcriptBase64: Buffer.from('{"type":"assistant"}\n', 'utf8').toString('base64'),
      },
      targetPath,
      env: {},
    })).rejects.toThrow(/remoteSessionId|session id|path/i);
  });
});
