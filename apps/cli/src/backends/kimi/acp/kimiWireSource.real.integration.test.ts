import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { createKimiBackend } from '@/backends/kimi/acp/backend';
import { createKimiLoopbackEnvironment, createKimiLoopbackModel, KIMI_FIXTURE_BACKGROUND, KIMI_FIXTURE_FOREGROUND, KIMI_FIXTURE_NESTED_BACKGROUND } from './kimiLoopbackModel.testkit';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const executable = process.env.HAPPIER_TEST_KIMI_PATH?.trim();

describe.skipIf(!executable || process.platform === 'win32')('Kimi journal and ACP delivery ordering', () => {
  let inheritedEnv: ReturnType<typeof createEnvKeyScope>;
  beforeEach(() => {
    inheritedEnv = createEnvKeyScope(['KIMI_MODEL', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY']);
    inheritedEnv.patch({
      KIMI_MODEL: 'fixture-must-not-inherit',
      OPENAI_BASE_URL: 'http://127.0.0.1:1',
      ANTHROPIC_API_KEY: 'fixture-must-not-inherit',
    });
  });
  afterEach(() => inheritedEnv.restore());

  it.each([
    { name: 'delivers a complete background turn before the foreground ACP response settles', continuationTool: false, nestedBackground: false },
    { name: 'defers a background approval until its foreground ACP response settles', continuationTool: true, nestedBackground: false },
    { name: 'retains a nested task while both native turns precede the foreground ACP response', continuationTool: false, nestedBackground: true },
  ])('$name', async ({ continuationTool, nestedBackground }) => {
    await withTempDir('happier-kimi-acp-order-', async (directory) => {
      const model = await createKimiLoopbackModel(directory, { continuationTool, nestedBackground });
      const permissions: string[] = [];
      const releaseResponse = join(directory, 'release-acp-response');
      const relay = join(directory, 'kimi-relay');
      await writeFile(relay, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const child = spawn(${JSON.stringify(executable)}, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'] });
const promptIds = new Set();
const pending = [];
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  // The initialize-only discovery probe does not use the backend launch policy.
  if (message.method === 'session/new' && ['KIMI_MODEL', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY'].some(key => process.env[key] !== undefined)) {
    throw new Error('Fixture process inherited a model override');
  }
  if (message.method === 'session/prompt') promptIds.add(message.id);
  child.stdin.write(line + '\\n');
});
createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (promptIds.has(message.id) && !existsSync(${JSON.stringify(releaseResponse)})) pending.push(line);
  else process.stdout.write(line + '\\n');
});
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(releaseResponse)})) return;
  for (const line of pending.splice(0)) process.stdout.write(line + '\\n');
}, 10);
timer.unref();
child.stderr.pipe(process.stderr);
child.on('exit', code => process.exit(code ?? 1));
process.stdin.on('end', () => child.stdin.end());
process.on('SIGTERM', () => child.kill('SIGTERM'));
`);
      await chmod(relay, 0o700);
      const backend = createKimiBackend({
        cwd: model.workspace,
        ...createKimiLoopbackEnvironment(model.home, relay),
        permissionMode: 'default',
        permissionHandler: { handleToolCall: async (toolCallId) => {
          permissions.push(toolCallId);
          return { decision: nestedBackground ? 'approved_for_session' : 'approved' };
        } },
      });
      const messages: AgentMessage[] = [];
      backend.onMessage(message => messages.push(message));
      const outputs = () => messages.filter(message => message.type === 'model-output').map(message => message.textDelta);
      try {
        const { sessionId } = await backend.startSession();
        await model.releaseBackground();
        await backend.sendPrompt(sessionId, 'Start the isolated background task.');
        await model.continuationRequested;
        model.releaseContinuation();
        await expect.poll(async () => (await model.readNativeEvents()).some(event =>
          continuationTool
            ? event.type === 'interaction.request' && (event.request as { turnId?: number } | undefined)?.turnId === 1
            : event.type === 'turn.ended' && event.turnId === (nestedBackground ? 2 : 1) && event.reason === 'completed',
        )).toBe(true);
        expect(permissions).toEqual(['0:call_background']);
        expect(outputs()).toContain(KIMI_FIXTURE_FOREGROUND);
        expect(outputs()).not.toContain(KIMI_FIXTURE_BACKGROUND);
        await writeFile(releaseResponse, 'ready');
        await backend.waitForResponseComplete?.();
        await expect.poll(outputs).toContain(KIMI_FIXTURE_BACKGROUND);
        expect(outputs().filter(output => output === KIMI_FIXTURE_BACKGROUND)).toHaveLength(1);
        if (nestedBackground) {
          await expect.poll(outputs).toContain(KIMI_FIXTURE_NESTED_BACKGROUND);
          expect(outputs().filter(output => output === KIMI_FIXTURE_NESTED_BACKGROUND)).toHaveLength(1);
        }
        if (continuationTool) {
          expect(permissions).toEqual(['0:call_background', '1:call_continuation']);
          expect(await model.continuationExecuted()).toBe(true);
        }
        await expect.poll(() => messages.filter(message => message.type === 'status'
          && message.status === 'idle' && message.turnFinished === true).length).toBe(nestedBackground ? 3 : 2);
      } finally {
        await writeFile(releaseResponse, 'ready');
        await backend.dispose();
        await model.close();
      }
    });
  }, 60_000);
});
