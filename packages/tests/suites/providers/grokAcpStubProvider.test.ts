import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';

type JsonRecord = Record<string, unknown>;

const children = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
});

function fixturePath(): string {
  return join(
    repoRootDir(),
    'packages/tests/src/testkit/providers/fixtures/grok-acp-stub-provider.mjs',
  );
}

async function createClient(recordPath: string, extensionResult: JsonRecord = {
  outcome: 'accepted',
  answers: Object.assign(Object.create(null), {
    'Where should this run?': ['Washington, D.C.', '__proto__'],
  }),
}) {
  const child = spawn(fixturePath(), ['--no-auto-update', 'agent', 'stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HAPPIER_GROK_STUB_RECORD_PATH: recordPath,
      XAI_API_KEY: 'fixture-super-secret-value',
    },
  });
  children.add(child);
  const pending = new Map<number, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void }>();
  const extensionRequests: JsonRecord[] = [];
  let nextId = 1;
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    const message = JSON.parse(line) as JsonRecord;
    const id = message.id;
    if (typeof message.method === 'string' && id !== undefined) {
      extensionRequests.push(message);
      child.stdin!.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: extensionResult,
      })}\n`);
      return;
    }
    if (typeof id !== 'number') return;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve((message.result as JsonRecord) ?? {});
  });

  const request = (method: string, params: JsonRecord = {}) => {
    const id = nextId++;
    const promise = new Promise<JsonRecord>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  };
  const notify = (method: string, params: JsonRecord = {}) => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  return { child, request, notify, extensionRequests };
}

describe('Grok ACP deterministic boundary fake', () => {
  it('rejects session opens until initialize and headless API-key authentication complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-grok-stub-'));
    const client = await createClient(join(dir, 'requests.jsonl'));

    await expect(client.request('session/new')).rejects.toThrow('initialize');
    await client.request('initialize');
    await expect(client.request('session/new')).rejects.toThrow('authenticate');
    await client.request('authenticate', { methodId: 'xai.api_key', _meta: { headless: true } });
    await expect(client.request('session/new')).resolves.toMatchObject({
      sessionId: 'grok-stub-session-1',
    });
  });

  it('fails startup when the backend launch argv is not the official exact sequence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-grok-stub-'));
    const child = spawn(fixturePath(), ['agent', 'stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HAPPIER_GROK_STUB_RECORD_PATH: join(dir, 'requests.jsonl'),
      },
    });
    children.add(child);
    const exitCode = await Promise.race([
      new Promise<number | null>((resolve) => child.once('exit', resolve)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
  });

  it('pins exact launch/auth/create/load/capability and sanitized recording contracts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-grok-stub-'));
    const recordPath = join(dir, 'requests.jsonl');
    const client = await createClient(recordPath);

    const initialized = await client.request('initialize');
    expect(initialized).toMatchObject({
      authMethods: [{ id: 'xai.api_key' }, { id: 'grok.com' }],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      _meta: { defaultAuthMethodId: 'xai.api_key' },
    });
    await expect(client.request('authenticate', {
      methodId: 'xai.api_key',
      _meta: { headless: true },
    })).resolves.toEqual({});

    const created = await client.request('session/new', {
      mcpServers: [{
        type: 'stdio',
        name: 'fixture',
        command: 'fixture-command',
        env: [{ name: 'XAI_API_KEY', value: 'fixture-mcp-secret' }],
      }],
    });
    expect(created).toMatchObject({
      sessionId: 'grok-stub-session-1',
      models: { currentModelId: 'grok-build', availableModels: [{ id: 'grok-build' }] },
    });
    await expect(client.request('session/load', { sessionId: 'grok-stub-session-1' }))
      .resolves.toMatchObject({ sessionId: 'grok-stub-session-1' });
    await expect(client.request('session/set_model', {
      sessionId: 'grok-stub-session-1',
      modelId: 'grok-build',
    })).resolves.toEqual({});
    await expect(client.request('session/set_model', {
      modelId: 'grok-build',
    })).rejects.toThrow('session');
    await expect(client.request('session/set_model', {
      sessionId: 'grok-stub-session-1',
      modelId: 'unknown',
    })).rejects.toThrow('unknown fixture model');
    await expect(client.request('session/set_mode', {
      sessionId: 'grok-stub-session-1',
      modeId: 'plan',
    })).resolves.toEqual({});
    await expect(client.request('session/set_mode', {
      sessionId: 'grok-stub-session-1',
      modeId: 'unknown',
    })).rejects.toThrow('unknown fixture mode');

    client.child.kill('SIGTERM');
    await new Promise<void>((resolve) => client.child.once('exit', () => resolve()));
    const records = (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records[0]).toEqual({ kind: 'startup', argv: ['--no-auto-update', 'agent', 'stdio'] });
    expect(records.slice(1).map((record) => record.method)).toEqual([
      'initialize',
      'authenticate',
      'session/new',
      'session/load',
      'session/set_model',
      'session/set_model',
      'session/set_model',
      'session/set_mode',
      'session/set_mode',
    ]);
    expect(JSON.stringify(records)).not.toContain('fixture-super-secret-value');
    expect(JSON.stringify(records)).not.toContain('fixture-mcp-secret');
  });

  it('exercises both xAI aliases, exact arrays, cancellation, and post-cancel continuation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-grok-stub-'));
    const client = await createClient(join(dir, 'requests.jsonl'));
    await client.request('initialize');
    await client.request('authenticate', { methodId: 'xai.api_key', _meta: { headless: true } });
    const created = await client.request('session/new');
    const sessionId = String(created.sessionId);

    await expect(client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'GROK_STUB_STRUCTURED_QUESTION' }],
    })).resolves.toEqual({ stopReason: 'end_turn' });
    await expect(client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'GROK_STUB_STRUCTURED_QUESTION_WRAPPED' }],
    })).resolves.toEqual({ stopReason: 'end_turn' });
    expect(client.extensionRequests.map((request) => request.method)).toEqual([
      'x.ai/ask_user_question',
      '_x.ai/ask_user_question',
    ]);

    const pending = client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'GROK_STUB_CANCEL' }],
    });
    let pendingSettled = false;
    void pending.finally(() => { pendingSettled = true; });
    client.notify('session/cancel', { sessionId: 'foreign-session' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pendingSettled).toBe(false);
    client.notify('session/cancel', { sessionId });
    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' });
    await expect(client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'AFTER_CANCEL' }],
    })).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('rejects a lossy or non-production xAI question response shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-grok-stub-'));
    const client = await createClient(join(dir, 'requests.jsonl'), {
      decision: 'approved',
      answers: { 'Where should this run?': 'Washington, D.C., __proto__' },
    });
    await client.request('initialize');
    await client.request('authenticate', { methodId: 'xai.api_key', _meta: { headless: true } });
    const created = await client.request('session/new');

    await expect(client.request('session/prompt', {
      sessionId: String(created.sessionId),
      prompt: [{ type: 'text', text: 'GROK_STUB_STRUCTURED_QUESTION' }],
    })).rejects.toThrow('question response');
  });
});
