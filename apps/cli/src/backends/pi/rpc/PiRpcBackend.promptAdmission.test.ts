import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AcpPromptSubmissionEvidence } from '@/agent/acp/AcpBackend';

import { PiRpcBackend } from './PiRpcBackend';

type ExpectedPiPromptAdmission =
  | { status: 'accepted' }
  | { status: 'rejected_before_effect'; error: Error }
  | { status: 'effect_may_have_occurred'; error: Error };

type ExpectedPiPromptSubmission = Readonly<{
  admission: Promise<ExpectedPiPromptAdmission>;
  completion: Promise<void>;
}>;

type PiRpcBackendWithPromptAdmission = PiRpcBackend & {
  sendPromptWithAdmission(sessionId: string, prompt: string): ExpectedPiPromptSubmission;
  sendPromptWithEvidence(sessionId: string, prompt: string): Promise<AcpPromptSubmissionEvidence>;
};

function makeFakePiRpcProcessScript(
  dir: string,
  scenario: 'ack-before-turn' | 'command-without-turn' | 'command-ack-before-turn' | 'command-state-unknown-before-turn' | 'negative-ack-then-turn' | 'response-loss' | 'turn-before-ack',
): string {
  const scriptPath = join(dir, `fake-pi-rpc-${scenario}.js`);
  const observedPromptsPath = join(dir, 'observed-prompts.jsonl');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const scenario = ${JSON.stringify(scenario)};

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  switch (command.type) {
    case 'new_session':
      out({ id: command.id, type: 'response', command: command.type, success: true, data: { cancelled: false } });
      break;
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: {
          sessionId: 'pi-prompt-admission-test',
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' },
          ...(scenario === 'command-state-unknown-before-turn'
            ? {}
            : { isStreaming: false, isCompacting: false }),
        },
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] },
      });
      break;
    case 'get_commands':
      out({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: {
          commands: scenario === 'command-without-turn'
            ? [{ name: 'goal', source: 'extension' }]
            : scenario === 'command-ack-before-turn' || scenario === 'command-state-unknown-before-turn'
              ? [{ name: 'goal', source: 'extension' }]
              : [],
        },
      });
      break;
    case 'prompt':
      fs.appendFileSync(${JSON.stringify(observedPromptsPath)}, JSON.stringify(command.message) + '\\n');
      if (scenario === 'command-without-turn') {
        out({ id: command.id, type: 'response', command: command.type, success: true });
        break;
      }
      if (scenario === 'command-ack-before-turn' || scenario === 'command-state-unknown-before-turn') {
        out({ id: command.id, type: 'response', command: command.type, success: true });
        const turnDelay = scenario === 'command-state-unknown-before-turn' ? 180 : 100;
        setTimeout(() => out({ type: 'agent_start' }), turnDelay);
        setTimeout(() => out({ type: 'agent_end' }), turnDelay + 40);
        break;
      }
      if (scenario === 'ack-before-turn') {
        out({ id: command.id, type: 'response', command: command.type, success: true });
        setTimeout(() => out({ type: 'agent_start' }), 100);
        setTimeout(() => out({ type: 'agent_end' }), 140);
        break;
      }
      if (scenario === 'negative-ack-then-turn') {
        out({ id: command.id, type: 'response', command: command.type, success: false, error: 'prompt rejected while busy' });
        setTimeout(() => out({ type: 'agent_start' }), 10);
        setTimeout(() => out({ type: 'agent_end' }), 30);
        break;
      }
      if (scenario === 'response-loss') {
        process.exit(1);
        break;
      }
      setTimeout(() => out({ type: 'agent_start' }), 5);
      setTimeout(() => out({ type: 'agent_end' }), 30);
      setTimeout(() => out({ id: command.id, type: 'response', command: command.type, success: true }), 120);
      break;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true });
      break;
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('PiRpcBackend prompt admission', () => {
  const tempDirs: string[] = [];
  const backends: PiRpcBackend[] = [];

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function startBackend(scenario: Parameters<typeof makeFakePiRpcProcessScript>[1]) {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-prompt-admission-'));
    tempDirs.push(dir);
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [makeFakePiRpcProcessScript(dir, scenario)],
      env: scenario === 'command-state-unknown-before-turn'
        ? { HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '25' }
        : {},
    });
    backends.push(backend);
    const session = await backend.startSession();
    return { backend: backend as PiRpcBackendWithPromptAdmission, sessionId: session.sessionId };
  }

  it('reports exact prompt RPC success before the provider turn completes', async () => {
    const { backend, sessionId } = await startBackend('ack-before-turn');

    const submission = backend.sendPromptWithAdmission(sessionId, 'hello');
    let completionSettled = false;
    void submission.completion.finally(() => {
      completionSettled = true;
    });

    await expect(submission.admission).resolves.toEqual({ status: 'accepted' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completionSettled).toBe(false);
    await expect(submission.completion).resolves.toBeUndefined();
  });

  it('preserves nonblank prompt bytes when sending them to Pi', async () => {
    const { backend, sessionId } = await startBackend('ack-before-turn');

    const prompt = '  /goal fix authentication  ';
    const submission = backend.sendPromptWithAdmission(sessionId, prompt);

    await expect(submission.admission).resolves.toEqual({ status: 'accepted' });
    await expect(submission.completion).resolves.toBeUndefined();
    expect(readFileSync(join(tempDirs[0]!, 'observed-prompts.jsonl'), 'utf8')).toBe(`${JSON.stringify(prompt)}\n`);
  });

  it('completes an advertised command that returns without starting an agent turn', async () => {
    const { backend, sessionId } = await startBackend('command-without-turn');

    const submission = backend.sendPromptWithAdmission(sessionId, '/goal fix authentication');

    await expect(submission.admission).resolves.toEqual({ status: 'accepted' });
    await expect(submission.completion).resolves.toBeUndefined();
  });

  it('does not complete an extension command before its delayed agent turn starts', async () => {
    const { backend, sessionId } = await startBackend('command-ack-before-turn');

    const submission = backend.sendPromptWithAdmission(sessionId, '/goal fix authentication');
    let completionSettled = false;
    void submission.completion.finally(() => {
      completionSettled = true;
    });

    await expect(submission.admission).resolves.toEqual({ status: 'accepted' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completionSettled).toBe(false);
    await expect(submission.completion).resolves.toBeUndefined();
  });

  it('does not treat incomplete state evidence as idle before a delayed extension-command turn', async () => {
    const { backend, sessionId } = await startBackend('command-state-unknown-before-turn');

    const submission = backend.sendPromptWithAdmission(sessionId, '/goal fix authentication');
    let completionSettled = false;
    void submission.completion.finally(() => {
      completionSettled = true;
    });

    await expect(submission.admission).resolves.toEqual({ status: 'accepted' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(completionSettled).toBe(false);
    await expect(submission.completion).resolves.toBeUndefined();
  });

  it('exposes exact prompt RPC acceptance to the shared ACP runtime before turn completion', async () => {
    const { backend, sessionId } = await startBackend('ack-before-turn');

    const evidence = await backend.sendPromptWithEvidence(sessionId, 'hello');

    expect(evidence).toEqual({ kind: 'accepted_without_exact_final_response' });
    let completionSettled = false;
    void backend.waitForResponseComplete().finally(() => {
      completionSettled = true;
    });
    expect(completionSettled).toBe(false);
    await expect(backend.waitForResponseComplete()).resolves.toBeUndefined();
  });

  it('keeps an exact negative prompt RPC response rejected when later uncorrelated turn events arrive', async () => {
    const { backend, sessionId } = await startBackend('negative-ack-then-turn');

    const submission = backend.sendPromptWithAdmission(sessionId, 'hello');

    const admission = await submission.admission;
    expect(admission).toMatchObject({
      status: 'rejected_before_effect',
      error: {
        name: 'PiRpcPromptRejectedBeforeEffectError',
        piProviderFailure: {
          classification: 'pi_provider_failure',
          code: 'pi_provider_session_error',
        },
      },
    });
    await expect(submission.completion).rejects.toThrow(/prompt rejected while busy/u);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(submission.admission).resolves.toBe(admission);
  });

  it('reports process loss after prompt dispatch as effect_may_have_occurred', async () => {
    const { backend, sessionId } = await startBackend('response-loss');

    const submission = backend.sendPromptWithAdmission(sessionId, 'hello');

    await expect(submission.admission).resolves.toMatchObject({
      status: 'effect_may_have_occurred',
    });
    await expect(submission.completion).rejects.toThrow();
  });

  it('does not infer prompt acceptance from provider turn events before the exact RPC response', async () => {
    const { backend, sessionId } = await startBackend('turn-before-ack');

    const submission = backend.sendPromptWithAdmission(sessionId, 'hello');
    const earlyAdmission = await Promise.race([
      submission.admission.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 70)),
    ]);

    expect(earlyAdmission).toBe('pending');
    await expect(submission.admission).resolves.toEqual({ status: 'accepted' });
    await expect(submission.completion).resolves.toBeUndefined();
  });
});
