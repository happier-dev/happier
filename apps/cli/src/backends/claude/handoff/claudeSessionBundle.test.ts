import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveClaudeProjectId } from '../utils/path';
import { resolveExistingClaudeSessionHandoffState } from '../sessionHandoff/resolveExistingSessionHandoffState';
import { exportClaudeSessionBundle } from './exportClaudeSessionBundle';
import { importClaudeSessionBundle } from './importClaudeSessionBundle';
import { readClaudeSessionTitle } from '../directSessions/readClaudeSessionTitle';

describe('claude session handoff bundle', () => {
  it.each(['inline', 'file'] as const)('refreshes cached titles when a %s handoff replaces an existing transcript', async (storage) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-title-'));
    const targetPath = join(root, 'workspace');
    const env = { HOME: root, USERPROFILE: root };
    const transcriptPath = join(root, '.claude', 'projects', resolveClaudeProjectId(targetPath), 'session-one.jsonl');
    const padding = `${JSON.stringify({ type: 'progress', data: 'x'.repeat(5_000) })}\n`;
    const transcript = (title: string) => `${padding}${JSON.stringify({ type: 'custom-title', customTitle: title })}\n${padding}`;
    const importTranscript = async (contents: string) => {
      const sourcePath = join(root, 'source.jsonl');
      await writeFile(sourcePath, contents, 'utf8');
      return importClaudeSessionBundle({
        bundle: {
          providerId: 'claude',
          remoteSessionId: 'session-one',
          ...(storage === 'file'
            ? { transcriptFile: { t: 'happier.handoff.file.v1' as const, filePath: sourcePath, offsetBytes: 0, sizeBytes: Buffer.byteLength(contents) } }
            : { transcriptBase64: Buffer.from(contents).toString('base64') }),
        },
        targetPath,
        env,
      });
    };

    await importTranscript(transcript('Original title'));
    await expect(readClaudeSessionTitle(transcriptPath)).resolves.toBe('Original title');
    // Neither rewrite changes the head or the previous boundary sample.
    await importTranscript(transcript('Modified title'));
    await expect(readClaudeSessionTitle(transcriptPath)).resolves.toBe('Modified title');
    await importTranscript(`${transcript('Replaced title')}${JSON.stringify({ type: 'progress', data: 'more' })}\n`);
    await expect(readClaudeSessionTitle(transcriptPath)).resolves.toBe('Replaced title');
  });

  it('preserves the previous transcript when importing an incomplete file slice fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-failed-copy-'));
    const targetPath = join(root, 'workspace');
    const env = { HOME: root, USERPROFILE: root };
    const contents = '{"type":"custom-title","customTitle":"Original title"}\n';
    await importClaudeSessionBundle({
      bundle: { providerId: 'claude', remoteSessionId: 'session-one', transcriptBase64: Buffer.from(contents).toString('base64') },
      targetPath,
      env,
    });
    const sourcePath = join(root, 'incomplete.jsonl');
    await writeFile(sourcePath, 'incomplete', 'utf8');
    await expect(importClaudeSessionBundle({
      bundle: {
        providerId: 'claude', remoteSessionId: 'session-one',
        transcriptFile: { t: 'happier.handoff.file.v1', filePath: sourcePath, offsetBytes: 0, sizeBytes: 100 },
      },
      targetPath,
      env,
    })).rejects.toThrow();
    const transcriptPath = join(root, '.claude', 'projects', resolveClaudeProjectId(targetPath), 'session-one.jsonl');
    await expect(readFile(transcriptPath, 'utf8')).resolves.toBe(contents);
  });

  it('keeps native default authentication unset for imported and existing target state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-native-auth-'));
    const targetPath = join(root, 'workspace');
    const env = { HOME: root, USERPROFILE: root };
    const imported = await importClaudeSessionBundle({
      bundle: {
        providerId: 'claude', remoteSessionId: 'native-auth-session',
        transcriptBase64: Buffer.from('{"type":"user"}\n').toString('base64'),
      },
      targetPath,
      env,
    });
    const existing = await resolveExistingClaudeSessionHandoffState({
      metadata: {}, vendorResumeId: 'native-auth-session', targetPath, env, sessionStorageMode: 'direct',
    });

    expect(imported.resume.environmentVariables).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(existing.resume.environmentVariables).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(existing.directSource).toEqual(imported.directSource);
    const projectId = resolveClaudeProjectId(targetPath);
    expect(await readFile(join(root, '.claude', 'projects', projectId, 'native-auth-session.jsonl'), 'utf8'))
      .toBe('{"type":"user"}\n');
  });
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
      transcriptFile: { t: 'happier.handoff.file.v1', filePath: transcriptPath, offsetBytes: 0, sizeBytes: 16 },
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
      transcriptFile: { t: 'happier.handoff.file.v1', filePath: transcriptPath, offsetBytes: 0, sizeBytes: 21 },
    });
  });

  it('resolves transcript heuristics from HAPPIER_CLAUDE_CONFIG_DIR when CLAUDE_CONFIG_DIR is not set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-export-happier-config-'));
    const workspacePath = join(root, 'workspace');
    const claudeConfigDir = join(root, '.claude-source');
    const projectId = resolveClaudeProjectId(workspacePath);
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
      transcriptFile: { t: 'happier.handoff.file.v1', filePath: transcriptPath, offsetBytes: 0, sizeBytes: 50 },
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
      transcriptFile: { t: 'happier.handoff.file.v1', filePath: transcriptPath, offsetBytes: 0, sizeBytes: 49 },
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
      transcriptFile: { t: 'happier.handoff.file.v1', filePath: liveTranscriptPath, offsetBytes: 0, sizeBytes: 42 },
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
    const projectId = resolveClaudeProjectId(targetPath);
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
    const configDir = join(root, '.claude-target');
    await mkdir(targetPath, { recursive: true });

    const result = await importClaudeSessionBundle({
      bundle: {
        providerId: 'claude',
        remoteSessionId: 'claude_session_2',
        transcriptBase64: Buffer.from('{"type":"assistant"}\n', 'utf8').toString('base64'),
      },
      targetPath,
      env: { CLAUDE_CONFIG_DIR: configDir },
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

  it('keeps imported Claude project ids length-safe for deep workspace roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-import-long-path-'));
    const targetPath = join(
      root,
      ...Array.from({ length: 12 }, (_, index) => `very-long-segment-${String(index).padStart(2, '0')}`),
      'repo-with-an-exceptionally-long-name-for-claude-project-id-derivation',
    );
    await mkdir(targetPath, { recursive: true });

    const result = await importClaudeSessionBundle({
      bundle: {
        providerId: 'claude',
        remoteSessionId: 'claude_session_long_path',
        transcriptBase64: Buffer.from('{"type":"assistant","text":"long-path"}\n', 'utf8').toString('base64'),
      },
      targetPath,
      env: {
        CLAUDE_CONFIG_DIR: join(root, '.claude-target'),
      },
    });

    const rawProjectId = resolve(targetPath).replace(/[^a-zA-Z0-9-]/g, '-');
    expect(result.directSource).toMatchObject({
      kind: 'claudeConfig',
      configDir: join(root, '.claude-target'),
    });
    const projectId = result.directSource.projectId as string;
    expect(projectId).not.toBe(rawProjectId);
    expect(projectId.length).toBeLessThan(120);

    const importedPath = join(root, '.claude-target', 'projects', projectId, 'claude_session_long_path.jsonl');
    await expect(readFile(importedPath, 'utf8')).resolves.toBe('{"type":"assistant","text":"long-path"}\n');
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
      projectId: resolveClaudeProjectId(targetPath),
    });
      expect(result.resume).toEqual({
        directory: targetPath,
        agent: 'claude',
        resume: 'claude_session_happier_override',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: configDir,
        },
        transcriptStorage: 'direct',
        approvedNewDirectoryCreation: true,
      });

    const projectId = resolveClaudeProjectId(targetPath);
    const importedPath = join(configDir, 'projects', projectId, 'claude_session_happier_override.jsonl');
    await expect(readFile(importedPath, 'utf8')).resolves.toBe('{"type":"assistant","text":"override"}\n');
  });

  it('uses the HOME-based transcript directory without an authentication override', async () => {
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
        projectId: resolveClaudeProjectId(targetPath),
      });
      expect(result.resume.environmentVariables).toEqual({});

      const projectId = resolveClaudeProjectId(targetPath);
      const importedPath = join(root, '.claude', 'projects', projectId, 'claude_session_home_fallback.jsonl');
      await expect(readFile(importedPath, 'utf8')).resolves.toBe('{"type":"assistant","text":"home-fallback"}\n');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('uses the import env HOME fallback even when process.env.HOME points somewhere else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-import-env-home-'));
    const targetPath = join(root, 'workspace');
    await mkdir(targetPath, { recursive: true });

    const previousHome = process.env.HOME;
    process.env.HOME = join(root, 'wrong-home');
    try {
      const result = await importClaudeSessionBundle({
        bundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_env_home',
          transcriptBase64: Buffer.from('{"type":"assistant","text":"env-home"}\n', 'utf8').toString('base64'),
        },
        targetPath,
        env: {
          HOME: join(root, 'expected-home'),
        },
      });

      expect(result.directSource).toEqual({
        kind: 'claudeConfig',
        configDir: join(root, 'expected-home', '.claude'),
        projectId: resolveClaudeProjectId(targetPath),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('rejects remote session ids that contain path separators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-import-invalid-id-'));
    const targetPath = join(root, 'workspace');
    const configDir = join(root, '.claude-target');
    await mkdir(targetPath, { recursive: true });
    const projectDir = join(configDir, 'projects', resolveClaudeProjectId(targetPath));

    await expect(importClaudeSessionBundle({
      bundle: {
        providerId: 'claude',
        remoteSessionId: '../escape',
        transcriptBase64: Buffer.from('{"type":"assistant"}\n', 'utf8').toString('base64'),
      },
      targetPath,
      env: { CLAUDE_CONFIG_DIR: configDir },
    })).rejects.toThrow(/remoteSessionId|session id|path/i);
    await expect(stat(projectDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
