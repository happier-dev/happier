import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

describe('fake Claude CLI fixture', () => {
  it('waits for synchronous hooks before emitting a local turn or starting the next one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-hook-order-'));
    const events: string[] = [];
    const blockedPrompts: ServerResponse[] = [];
    const blockedStops: ServerResponse[] = [];
    let closing = false;
    // The HTTP boundary holds hook subprocesses open without depending on process scheduling.
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        const event = JSON.parse(body).hook_event_name as string;
        events.push(event);
        if (event === 'UserPromptSubmit' && !closing) blockedPrompts.push(response);
        else if (event === 'Stop' && !closing) blockedStops.push(response);
        else response.end();
      });
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP hook server');
      const forwarderPath = join(dir, 'forwarder.cjs');
      await writeFile(forwarderPath, `
        const http = require('node:http');
        const request = http.request({ hostname: '127.0.0.1', port: Number(process.argv[2]), method: 'POST' },
          response => response.resume());
        process.stdin.pipe(request);
      `);
      const settingsPath = join(dir, 'settings.json');
      await writeFile(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(forwarderPath)} ${address.port}`,
      }] }] } }));
      const logPath = join(dir, 'fake-claude.jsonl');
      const completedTurns = async () => (await readFile(logPath, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line)).filter((event) => event.type === 'local_stdin_turn_completed');
      child = spawn(process.execPath, [resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs'), '--settings', settingsPath], {
        cwd: dir,
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      await expect.poll(() => events).toEqual(['SessionStart']);
      child.stdin?.write('first prompt\rsecond prompt\r');
      await expect.poll(() => blockedPrompts.length).toBeGreaterThan(0);
      expect(await completedTurns()).toHaveLength(0);
      expect(events).toEqual(['SessionStart', 'UserPromptSubmit']);
      blockedPrompts[0].end();
      await expect.poll(() => blockedStops.length).toBe(1);
      expect(await completedTurns()).toHaveLength(1);
      expect(events).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
      blockedStops[0].end();
      await expect.poll(() => blockedPrompts.length).toBe(2);
      expect(await completedTurns()).toHaveLength(1);
      expect(events).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'UserPromptSubmit']);
      blockedPrompts[1].end();
      await expect.poll(() => blockedStops.length).toBe(2);
      expect((await completedTurns()).map((turn) => turn.turn)).toEqual([1, 2]);
      expect(events).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'UserPromptSubmit', 'Stop']);
      blockedStops[1].end();
    } finally {
      closing = true;
      for (const response of [...blockedPrompts, ...blockedStops]) response.end();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not execute unparseable SessionStart hook commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-hook-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const sideEffectPath = join(dir, 'side-effect.txt');

      const settingsPath = join(dir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      // Deliberately NOT in the strict node "<script>" <port> form.
                      command: `node -e "require('fs').writeFileSync('${sideEffectPath.replace(/\\/g, '\\\\')}', 'pwned')"` ,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');
      const res = spawnSync(process.execPath, [fixturePath, '--print', '--output-format', 'stream-json', '--settings', settingsPath], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
        },
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);

      // Side effect file should never be created.
      await expect(stat(sideEffectPath)).rejects.toThrow();

      const raw = await readFile(logPath, 'utf8');
      const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(lines.some((l) => l?.type === 'hook_skipped' && l?.reason === 'unparseable_command')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
