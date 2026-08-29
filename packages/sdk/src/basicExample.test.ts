import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const basicExamplePath = fileURLToPath(new URL('../examples/basic/index.ts', import.meta.url));
const comprehensiveExamplePath = fileURLToPath(new URL('../examples/comprehensive/index.ts', import.meta.url));
const sensitivePayload = 'encrypted-transcript-payload'.repeat(1_000);
const BASIC_EXAMPLE_CHILD_TIMEOUT_MS = 60_000;
const BASIC_EXAMPLE_TEST_TIMEOUT_MS = BASIC_EXAMPLE_CHILD_TIMEOUT_MS + 5_000;

/**
 * Generic request-body parser for the fake HTTP server. It never inspects
 * Action-specific fields; the requestId echo below relies only on the outer
 * public envelope so real request-correlation behavior is exercised.
 */
async function readJsonObjectBody(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : {};
  } catch {
    return {};
  }
}

function actionResponse(actionId: string): Readonly<Record<string, unknown>> {
  if (actionId === 'agents.backends.list') {
    return {
      v: 1,
      actionId,
      execution: {
        ok: true,
        result: {
          items: [{
            targetKey: 'backend:happier.agent.codex',
            label: 'Codex',
            enabled: true,
            agentId: 'codex',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          }],
        },
      },
    };
  }

  if (actionId === 'session.spawn_new') {
    return {
      v: 1,
      actionId,
      execution: {
        ok: true,
        result: {
          type: 'success',
          disposition: 'created',
          sessionId: 'session-1',
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          organizationPlacement: { folderId: null, tagIds: [] },
          initialInput: {
            status: 'rejected',
            code: 'session_input_target_update_required',
          },
        },
      },
    };
  }

  if (actionId === 'session.stop') {
    return {
      v: 1,
      actionId,
      execution: { ok: true, result: { stopped: true } },
    };
  }

  throw new Error(`Unexpected Action request: ${actionId}`);
}

function successfulActionResponse(actionId: string): Readonly<Record<string, unknown>> {
  if (actionId === 'agents.backends.list') {
    return {
      v: 1,
      actionId,
      execution: {
        ok: true,
        result: {
          items: [{
            targetKey: 'backend:happier.agent.codex',
            label: 'Codex',
            enabled: true,
            agentId: 'codex',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          }],
        },
      },
    };
  }

  if (actionId === 'session.spawn_new') {
    return {
      v: 1,
      actionId,
      execution: {
        ok: true,
        result: {
          type: 'success',
          disposition: 'created',
          sessionId: 'session-1',
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          organizationPlacement: { folderId: null, tagIds: [] },
          initialInput: { status: 'accepted', localId: 'initial-input-1' },
        },
      },
    };
  }

  if (actionId === 'session.wait.idle') {
    return { v: 1, actionId, execution: { ok: true, result: { ok: true } } };
  }

  if (actionId === 'transcript.follow') {
    return {
      v: 1,
      actionId,
      execution: {
        ok: true,
        result: {
          items: [{ id: 'followed-1', text: 'Followed text', payload: sensitivePayload }],
          nextCursor: '1',
          truncated: false,
          leaseId: 'lease-1',
        },
      },
    };
  }

  if (actionId === 'transcript.unfollow') {
    return { v: 1, actionId, execution: { ok: true, result: { ok: true, released: true } } };
  }

  if (actionId === 'session.message.send') {
    return { v: 1, actionId, execution: { ok: true, result: { accepted: true } } };
  }

  if (actionId === 'session.transcript.get') {
    return {
      v: 1,
      actionId,
      execution: {
        ok: true,
        result: {
          ok: true,
          sessionId: 'session-1',
          items: [{
            id: 'history-1',
            createdAt: 1,
            semanticRole: 'assistant',
            role: 'assistant',
            kind: 'assistant_message',
            text: 'The requested task is complete.',
            raw: { payload: sensitivePayload },
          }],
          nextCursor: null,
          hasMore: false,
          diagnostics: {
            rawRowsScanned: 1,
            pagesFetched: 1,
            scanLimitReached: false,
            payloadTruncations: 0,
          },
        },
      },
    };
  }

  if (actionId === 'session.stop') {
    return { v: 1, actionId, execution: { ok: true, result: { stopped: true } } };
  }

  throw new Error(`Unexpected Action request: ${actionId}`);
}

async function runBasicExample(
  respond: (actionId: string) => Readonly<Record<string, unknown>>,
  options: Readonly<{
    endpointMode?: 'daemon' | 'server';
    machineId?: string;
    machines?: readonly unknown[];
    examplePath?: string;
  }> = {},
): Promise<Readonly<{
  actionIds: readonly string[];
  exitCode: number | null;
  stderr: string;
  stdout: string;
}>> {
  const actionIds: string[] = [];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname.endsWith('/v1/machines')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(options.machines ?? []));
      return;
    }
    const actionId = decodeURIComponent(
      pathname.split('/').at(-1) ?? '',
    );
    actionIds.push(actionId);
    // Echo the exact requestId the caller sent on the outer envelope. Mutating
    // Actions always carry one, so the client's response-correlation check is
    // now proven over a real HTTP round-trip instead of a fetch mock.
    const requestBody = await readJsonObjectBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ...respond(actionId),
      ...(typeof requestBody.requestId === 'string'
        ? { requestId: requestBody.requestId }
        : {}),
    }));
  });
  let child: ReturnType<typeof spawn> | undefined;
  let childClose: ReturnType<typeof once> | undefined;
  let childTimeout: ReturnType<typeof setTimeout> | undefined;

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP mock server address.');
    }

    const spawnedChild = spawn(process.execPath, ['--import', 'tsx', options.examplePath ?? comprehensiveExamplePath], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      env: {
        ...process.env,
        HAPPIER_API_ENDPOINT: `http://127.0.0.1:${address.port}`,
        HAPPIER_TOKEN: 'test-token',
        HAPPIER_ENDPOINT_MODE: options.endpointMode ?? 'daemon',
        HAPPIER_MACHINE_ID: options.machineId ?? '',
        HAPPIER_AGENT_ID: 'codex',
        HAPPIER_WORKSPACE_PATH: '/repo',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = spawnedChild;
    let stderr = '';
    let stdout = '';
    spawnedChild.stderr.setEncoding('utf8');
    spawnedChild.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    spawnedChild.stdout.setEncoding('utf8');
    spawnedChild.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    childClose = once(spawnedChild, 'close');
    const childTimedOut = new Promise<never>((_resolve, reject) => {
      childTimeout = setTimeout(() => {
        reject(new Error(`Basic SDK example child did not exit within ${BASIC_EXAMPLE_CHILD_TIMEOUT_MS}ms.`));
      }, BASIC_EXAMPLE_CHILD_TIMEOUT_MS);
    });
    const [exitCode] = await Promise.race([childClose, childTimedOut]) as [
      number | null,
      NodeJS.Signals | null,
    ];

    return { actionIds, exitCode, stderr, stdout };
  } finally {
    if (childTimeout !== undefined) {
      clearTimeout(childTimeout);
    }
    try {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await childClose?.catch(() => undefined);
    } finally {
      if (server.listening) {
        server.close();
        await once(server, 'close');
      }
    }
  }
}

describe('comprehensive SDK example', () => {
  it('requires an explicit machine when several eligible server machines are available', async () => {
    const result = await runBasicExample(actionResponse, {
      endpointMode: 'server',
      machines: [
        { id: 'machine-alpha', active: true, revokedAt: null, replacedByMachineId: null },
        { id: 'machine-revoked', active: true, revokedAt: 1, replacedByMachineId: null },
        { id: 'machine-beta', active: true, revokedAt: null, replacedByMachineId: null },
      ],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('HAPPIER_MACHINE_ID');
    expect(result.stderr).toContain('machine-alpha');
    expect(result.stderr).toContain('machine-beta');
    expect(result.stderr).not.toContain('machine-revoked');
    expect(result.actionIds).toEqual([]);
  }, BASIC_EXAMPLE_TEST_TIMEOUT_MS);

  it('reports when no eligible server machine is available', async () => {
    const result = await runBasicExample(actionResponse, {
      endpointMode: 'server',
      machines: [
        { id: 'machine-inactive', active: false, revokedAt: null, replacedByMachineId: null },
        { id: 'machine-replaced', active: true, revokedAt: null, replacedByMachineId: 'machine-new' },
      ],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('No eligible active machine is available');
    expect(result.actionIds).toEqual([]);
  }, BASIC_EXAMPLE_TEST_TIMEOUT_MS);

  it('uses an explicit server machine without listing candidates', async () => {
    const result = await runBasicExample(actionResponse, {
      endpointMode: 'server',
      machineId: 'machine-chosen',
      machines: [
        { id: 'machine-alpha', active: true, revokedAt: null, replacedByMachineId: null },
        { id: 'machine-beta', active: true, revokedAt: null, replacedByMachineId: null },
      ],
    });

    expect(result.stderr).toContain('HappierSessionInitialInputError');
    expect(result.actionIds).toEqual([
      'agents.backends.list',
      'session.spawn_new',
      'session.stop',
    ]);
  }, BASIC_EXAMPLE_TEST_TIMEOUT_MS);

  it('stops a committed Session before reporting a rejected initial message', async () => {
    const result = await runBasicExample(actionResponse);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('HappierSessionInitialInputError');
    expect(result.actionIds).toEqual([
      'agents.backends.list',
      'session.spawn_new',
      'session.stop',
    ]);
  }, BASIC_EXAMPLE_TEST_TIMEOUT_MS);

  it('prints a compact semantic transcript summary instead of raw transcript payloads', async () => {
    const result = await runBasicExample(successfulActionResponse);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sessionId: 'session-1',
      followedItemCount: 1,
      historyOk: true,
      history: [{
        id: 'history-1',
        role: 'assistant',
        kind: 'assistant_message',
        text: 'The requested task is complete.',
      }],
    });
    expect(result.stdout).not.toContain(sensitivePayload);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThan(1_000);
    expect(result.actionIds).toEqual([
      'agents.backends.list',
      'session.spawn_new',
      'session.wait.idle',
      'transcript.follow',
      'transcript.unfollow',
      'session.message.send',
      'session.transcript.get',
      'session.stop',
    ]);
  }, BASIC_EXAMPLE_TEST_TIMEOUT_MS);
});

describe('basic SDK example', () => {
  it('prints the assistant result and exits after releasing follow and stopping the Session', async () => {
    const result = await runBasicExample(successfulActionResponse, { examplePath: basicExamplePath });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('The requested task is complete.');
    expect(result.stdout).not.toContain(sensitivePayload);
    expect(result.actionIds).toEqual([
      'agents.backends.list',
      'session.spawn_new',
      'session.message.send',
      'transcript.follow',
      'transcript.unfollow',
      'session.transcript.get',
      'session.stop',
    ]);
  }, BASIC_EXAMPLE_TEST_TIMEOUT_MS);
});
