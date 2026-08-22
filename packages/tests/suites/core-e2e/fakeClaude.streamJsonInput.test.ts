import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';

function parseJsonLines(raw: string): any[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

describe('fake Claude CLI fixture', () => {
  it('uses scenario-owned controls when the parent fake-control environment is filtered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-shim-'));
    try {
      const ambientHome = join(dir, 'ambient-home');
      await mkdir(ambientHome, { recursive: true });
      const fixture = await createIsolatedFakeClaudeControlShim({
        testDir: dir,
        invocationId: 'isolated-invocation',
        captureEnvironmentKeys: ['ANTHROPIC_API_KEY'],
        logFullStdin: true,
      });
      const marker = 'ISOLATED_FAKE_CLAUDE_STDIN';
      const input = JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: marker }] },
      });
      const filteredParentEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: ambientHome,
        ANTHROPIC_API_KEY: 'scenario-provider-key',
      };
      for (const key of Object.keys(filteredParentEnv)) {
        if (key.startsWith('HAPPIER_E2E_FAKE_CLAUDE_') || key === 'CLAUDE_CONFIG_DIR') {
          delete filteredParentEnv[key];
        }
      }

      const res = spawnSync(
        process.execPath,
        [fixture.executablePath, '--output-format', 'stream-json', '--input-format', 'stream-json'],
        {
          cwd: dir,
          env: filteredParentEnv,
          input: `${input}\n`,
          encoding: 'utf8',
        },
      );

      expect(res.status).toBe(0);
      const events = parseJsonLines(await readFile(fixture.logPath, 'utf8'));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'invocation',
          invocationId: 'isolated-invocation',
          environmentAttestation: {
            ANTHROPIC_API_KEY: expect.objectContaining({ present: true }),
          },
        }),
        expect.objectContaining({
          type: 'sdk_stdin',
          invocationId: 'isolated-invocation',
          userText: marker,
        }),
      ]));
      expect(await readdir(ambientHome, { recursive: true })).toEqual([]);
      expect(await readdir(fixture.configDir, { recursive: true }))
        .toEqual(expect.arrayContaining([expect.stringMatching(/\.jsonl$/)]));
      expect(fixture.executablePath).toBe(resolve(join(dir, 'fake-claude-control.mjs')));
      expect(fixture.logPath).toBe(resolve(join(dir, 'fake-claude.jsonl')));
      expect(fixture.configDir).toBe(resolve(join(dir, 'fake-claude-config')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('acknowledges control_request messages with a control_response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-control-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');

      const input = [
        JSON.stringify({ type: 'control_request', request_id: 'req-1', request: { subtype: 'initialize' } }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
      ].join('\n');

      const res = spawnSync(process.execPath, [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: 'inv-1',
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: 'session-1',
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);

      const rows = parseJsonLines(res.stdout);
      const response = rows.find((row) => row?.type === 'control_response');
      expect(response?.response?.subtype).toBe('success');
      expect(response?.response?.request_id).toBe('req-1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('responds to role=user messages even when message type differs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-stream-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');

      const input = JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      });

      const res = spawnSync(process.execPath, [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: 'inv-1',
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: 'session-1',
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);

      const rows = parseJsonLines(res.stdout);
      const assistant = rows.find((row) => row?.type === 'assistant');
      expect(assistant?.message?.content?.[0]?.text).toBe('FAKE_CLAUDE_OK_1');

      const logRaw = await readFile(logPath, 'utf8');
      expect(parseJsonLines(logRaw).some((row) => row?.type === 'invocation')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('can opt into logging full user stdin text for targeted assertions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-full-stdin-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');
      const marker = 'FULL_STDIN_MARKER_AFTER_PREVIEW';
      const longText = `${'x'.repeat(900)}${marker}`;

      const input = JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: longText }] },
      });

      const res = spawnSync(process.execPath, [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: 'inv-1',
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: 'session-1',
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);

      const logRaw = await readFile(logPath, 'utf8');
      const stdinRow = parseJsonLines(logRaw).find((row) => row?.type === 'sdk_stdin' && row?.hasUserText === true);
      expect(stdinRow?.userTextPreview).not.toContain(marker);
      expect(typeof stdinRow?.userText).toBe('string');
      expect(String(stdinRow?.userText ?? '')).toContain(marker);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps UCX_VOICE_READ_A read-only and makes UCX_VOICE_OPEN_B explicitly read then invoke', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-explicit-current-ui-command-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');
      const readResult = {
        toolResults: [{
          t: 'readCurrentUiContext',
          args: {},
          result: {
            entity: { label: 'Issue A' },
            navigation: { screen: 'triage.detail' },
            commands: [{ id: 'current-ui:issue-a:open-b', title: 'Open issue B' }],
          },
        }],
      };
      const invokeResult = {
        toolResults: [{
          t: 'invokeCurrentUiCommand',
          args: { commandId: 'current-ui:issue-a:open-b' },
          result: { ok: true },
        }],
      };
      const input = [
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'UCX_VOICE_READ_A' }] },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify(readResult)}` }],
          },
        }),
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'UCX_VOICE_OPEN_B' }] },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify(readResult)}` }],
          },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify(invokeResult)}` }],
          },
        }),
      ].join('\n');

      const res = spawnSync(process.execPath, [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'voice-current-ui-triage',
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);
      const assistantTexts = parseJsonLines(res.stdout)
        .filter((row) => row?.type === 'assistant')
        .map((row) => row?.message?.content?.[0]?.text);
      expect(assistantTexts[0]).toContain('readCurrentUiContext');
      expect(assistantTexts[1]).toBe('UCX Voice read the current UI context.');
      expect(assistantTexts[1]).not.toContain('invokeCurrentUiCommand');
      expect(assistantTexts[2]).toContain('readCurrentUiContext');
      expect(assistantTexts[3]).toContain('invokeCurrentUiCommand');
      expect(assistantTexts[3]).toContain('current-ui:issue-a:open-b');
      expect(assistantTexts[4]).toBe('UCX Voice current UI command completed.');
      expect(assistantTexts.filter((text) => String(text).includes('invokeCurrentUiCommand'))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('models the Local Agent delayed current-UI command result contract', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-current-ui-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const releaseFilePath = join(dir, 'release-delayed-current-ui-command');
      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');
      await writeFile(releaseFilePath, 'release\n', 'utf8');

      const readResult = {
        toolResults: [{
          t: 'readCurrentUiContext',
          args: {},
          result: {
            navigation: { screen: 'triage.detail' },
            commands: [{ id: 'current-ui:issue-a:open-b', title: 'Open issue B' }],
          },
        }],
      };
      const invokeResult = {
        toolResults: [{
          t: 'invokeCurrentUiCommand',
          args: null,
          result: { ok: true },
        }],
      };
      const input = [
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'UCX_VOICE_DELAYED_STALE_A' }] },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify(readResult)}` }],
          },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify(invokeResult)}` }],
          },
        }),
      ].join('\n');

      const res = spawnSync(process.execPath, [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'voice-current-ui-triage',
          HAPPIER_E2E_FAKE_CLAUDE_RUNTIME_CONTINUITY_RELEASE_FILE: releaseFilePath,
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);
      const assistantTexts = parseJsonLines(res.stdout)
        .filter((row) => row?.type === 'assistant')
        .map((row) => row?.message?.content?.[0]?.text);
      expect(assistantTexts[0]).toContain('readCurrentUiContext');
      expect(assistantTexts[1]).toContain('invokeCurrentUiCommand');
      expect(assistantTexts[1]).toContain('current-ui:issue-a:open-b');
      expect(assistantTexts[2]).toContain('UCX Voice current UI command completed.');

      const logRows = parseJsonLines(await readFile(logPath, 'utf8'));
      expect(logRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'triage_current_ui_read_requested' }),
        expect.objectContaining({ type: 'triage_current_ui_delayed_command_ready' }),
        expect.objectContaining({ type: 'triage_current_ui_command_result_received' }),
      ]));
      const providerPrompts = logRows
        .filter((row) => row?.type === 'sdk_stdin' && row?.hasUserText === true)
        .map((row) => String(row.userText ?? ''));
      expect(providerPrompts.some((prompt) => prompt.includes('current-ui:issue-a:open-b'))).toBe(true);
      expect(providerPrompts.some((prompt) => prompt.includes('"ok":true'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retains an A-surface command across one fake-Agent process and refuses it after normal navigation reaches B', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-stale-current-ui-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');
      const stagedReadResult = {
        toolResults: [{
          t: 'readCurrentUiContext',
          args: {},
          result: {
            entity: { label: 'Issue A' },
            navigation: { screen: 'triage.detail' },
            commands: [{ id: 'current-ui:issue-a:open-b', title: 'Open issue B' }],
          },
        }],
      };
      const staleInvokeResult = {
        toolResults: [{
          t: 'invokeCurrentUiCommand',
          args: { commandId: 'current-ui:issue-a:open-b' },
          result: { errorCode: 'stale_surface' },
        }],
      };
      const input = [
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'UCX_VOICE_STAGE_STALE_A' }] },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify(stagedReadResult)}` }],
          },
        }),
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'UCX_VOICE_INVOKE_STALE_A' }] },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify(staleInvokeResult)}` }],
          },
        }),
      ].join('\n');

      const res = spawnSync(process.execPath, [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'voice-current-ui-triage',
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);
      const assistantTexts = parseJsonLines(res.stdout)
        .filter((row) => row?.type === 'assistant')
        .map((row) => row?.message?.content?.[0]?.text);
      expect(assistantTexts[0]).toContain('readCurrentUiContext');
      expect(assistantTexts[1]).toBe('UCX Voice staged Issue A → Open issue B for stale check.');
      expect(assistantTexts[2]).toContain('invokeCurrentUiCommand');
      expect(assistantTexts[2]).toContain('current-ui:issue-a:open-b');
      expect(assistantTexts[3]).toBe('UCX Voice refused stale current UI command: stale_surface.');

      const logRows = parseJsonLines(await readFile(logPath, 'utf8'));
      expect(logRows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'triage_current_ui_stale_command_staged',
          commandId: 'current-ui:issue-a:open-b',
          entityTitle: 'Issue A',
          commandTitle: 'Open issue B',
        }),
        expect.objectContaining({
          type: 'triage_current_ui_stale_command_requested',
          commandId: 'current-ui:issue-a:open-b',
        }),
        expect.objectContaining({
          type: 'triage_current_ui_stale_command_refused',
          commandId: 'current-ui:issue-a:open-b',
          errorCode: 'stale_surface',
        }),
      ]));
      const providerPrompts = logRows
        .filter((row) => row?.type === 'sdk_stdin' && row?.hasUserText === true)
        .map((row) => String(row.userText ?? ''));
      expect(providerPrompts.some((prompt) => prompt.includes('current-ui:issue-a:open-b'))).toBe(true);
      expect(providerPrompts.some((prompt) => prompt.includes('"errorCode":"stale_surface"'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('publishes execution-run runtime metadata for the permission prompt scenario', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-runtime-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');

      const input = JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      });

      const res = spawnSync(process.execPath, [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: 'inv-1',
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: 'session-1',
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'permission-prompt-write',
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);

      const rows = parseJsonLines(res.stdout);
      expect(rows.some((row) => row?.type === 'event' && row?.name === 'runtime.descriptor')).toBe(true);
      expect(rows.some((row) => row?.type === 'event' && row?.name === 'runtime.capabilities')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
