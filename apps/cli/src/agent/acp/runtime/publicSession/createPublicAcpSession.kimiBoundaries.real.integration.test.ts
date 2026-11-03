import { access, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  AgentAcpRuntimeOptions,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createKimiAgentRuntime } from '../../../../../../../packages/plugins/kimi/src/agent/runtime/factory';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';
import {
  createKimiLoopbackModel,
  createKimiLoopbackEnvironment,
  KIMI_FIXTURE_BACKGROUND,
  KIMI_FIXTURE_FOREGROUND,
  KIMI_FIXTURE_NESTED_BACKGROUND,
  type KimiLoopbackModelOptions,
} from '../../testkit/kimiLoopbackModel';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const executable = process.env.HAPPIER_TEST_KIMI_PATH?.trim();
type Event = AgentSessionRuntimeEvent;
type Model = Awaited<ReturnType<typeof createKimiLoopbackModel>>;
type Setup = Readonly<{
  directory: string;
  model: Model;
}>;
type Fixture = Setup & Readonly<{
  runtime: AgentSessionRuntime;
  events: Event[];
  approvals: unknown[];
  send(): Promise<void>;
  waitForTerminal(turnId: string, kind?: 'turn-complete' | 'turn-cancelled'): Promise<void>;
}>;
type Options = Readonly<{
  model?: KimiLoopbackModelOptions | ((directory: string) => KimiLoopbackModelOptions);
  approved?: boolean;
  persistApproval?: boolean;
  mcpServers?(input: Setup): Promise<AgentSessionOpenRequest['mcpServers']>;
  prepare?(input: Setup): Promise<Readonly<{ executablePath: string; args?: string[] }> | void>;
}>;

async function withOfficialSession(options: Options, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withTempDir('kimi-public-boundaries-', async directory => {
    const model = await createKimiLoopbackModel(directory,
      typeof options.model === 'function' ? options.model(directory) : options.model);
    const lifetime = new AbortController();
    const events: Event[] = [];
    const approvals: unknown[] = [];
    let runtime: AgentSessionRuntime | undefined;
    try {
      const launch = await options.prepare?.({ directory, model }) ?? { executablePath: executable! };
      const dependencies: PublicAcpComposerDependencies = {
        pluginId: 'happier.agent.kimi', agentId: 'kimi',
        signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted,
        systemTools: { resolve: async () => ({ toolId: 'kimi-cli', launch: { kind: 'binary', ...launch } }) },
        interactions: { request: async (request, input) => {
          approvals.push({ request, permissionContext: input?.permissionContext });
          return options.approved === false ? { status: 'declined' as const }
            : { status: 'approved' as const, ...(options.persistApproval ? { persistence: 'session' as const } : {}) };
        } },
        media: { async registerSourceRoot() { throw new Error('Unexpected generated media'); } },
        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      };
      const factory = await createKimiAgentRuntime({
        plugin: { id: 'happier.agent.kimi', version: '0.0.0' },
        agent: { id: 'kimi' }, signal: lifetime.signal,
      });
      if (!factory.sessions) throw new Error('Missing Kimi session factory');
      const context = { signal: lifetime.signal, protocols: { acp: {
        open: (request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) =>
          createPublicAcpSession(request, options, dependencies),
      } } } as AgentSessionRuntimeContext;
      runtime = await factory.sessions.open({
        kind: 'create', sessionId: 'public-boundary', cwd: model.workspace,
        ...(options.mcpServers ? { mcpServers: await options.mcpServers({ directory, model }) } : {}),
        launchEnvironment: createKimiLoopbackEnvironment(model.home),
      }, context);
      const session = runtime;
      session.watch(event => { events.push(event); });
      await run({
        directory, model, runtime: session, events, approvals,
        async send() {
          expect(await session.send({
            inputIds: ['fixture-input'], input: { text: 'Run the isolated fixture.' },
            delivery: { kind: 'newTurn', turnId: 'parent' },
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
          })).toEqual({ status: 'admitted' });
        },
        async waitForTerminal(turnId, kind = 'turn-complete') {
          await expect.poll(() => events.some(event => event.kind === kind && event.turnId === turnId),
            { timeout: 15_000 }).toBe(true);
        },
      });
    } finally {
      model.releaseContinuation();
      await model.releaseBackground();
      await runtime?.dispose();
      lifetime.abort();
      await model.close();
    }
  });
}

describe.skipIf(!executable || process.platform === 'win32')('official Kimi public ACP boundaries', () => {
  let env: ReturnType<typeof createEnvKeyScope>;
  beforeEach(() => {
    env = createEnvKeyScope(['HAPPIER_ACP_FS', 'KIMI_MODEL', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY']);
    env.patch({ HAPPIER_ACP_FS: '1', KIMI_MODEL: 'fixture-must-not-inherit',
      OPENAI_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'fixture-must-not-inherit' });
  });
  afterEach(() => env.restore());

  it.each(['inside', 'outside', 'symlink'] as const)('enforces workspace ownership for an %s read', async location => {
    const marker = 'KIMI_PUBLIC_READ_MARKER';
    await withOfficialSession({
      model: directory => ({ filesystem: {
        tool: 'Read', path: location === 'outside' ? join(directory, 'outside.txt') : join(directory, 'workspace', 'inside.txt'),
      } }),
      prepare: async ({ directory, model }) => {
        const outside = join(directory, 'outside.txt');
        const inside = join(model.workspace, 'inside.txt');
        await writeFile(outside, marker);
        if (location === 'symlink') await symlink(outside, inside);
        else if (location === 'inside') await writeFile(inside, marker);
      },
    }, async ({ send, waitForTerminal, model }) => {
      await send();
      await waitForTerminal('parent');
      expect(model.getRequestCount()).toBe(2);
      const result = model.getToolResponses().join('\n');
      if (location === 'inside') expect(result).toContain(marker);
      else {
        expect(result).toContain('<system>ERROR: Tool execution failed.</system>');
        expect(result).not.toContain(marker);
      }
    });
  }, 60_000);

  it.each([true, false])('honors approved=%s before a native write effect', async approved => {
    const marker = 'KIMI_PUBLIC_WRITE_MARKER';
    await withOfficialSession({
      approved,
      model: directory => ({ filesystem: {
        tool: 'Write', path: join(directory, 'workspace', 'write-sentinel.txt'), content: marker,
      } }),
    }, async ({ send, waitForTerminal, model, approvals }) => {
      await send();
      await waitForTerminal('parent', approved ? 'turn-complete' : 'turn-cancelled');
      expect(approvals.length).toBeGreaterThan(0);
      const path = join(model.workspace, 'write-sentinel.txt');
      if (approved) {
        expect(model.getRequestCount()).toBe(2);
        expect(await readFile(path, 'utf8')).toBe(marker);
        expect(approvals).toContainEqual(expect.objectContaining({
          permissionContext: expect.objectContaining({ origin: 'host_acp_fs_write', turnId: 'parent' }),
        }));
      } else {
        expect(model.getRequestCount()).toBe(1);
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  }, 60_000);

  it.each([
    { name: 'completed continuation', continuationTool: false, nestedBackground: false },
    { name: 'continuation approval', continuationTool: true, nestedBackground: false },
    { name: 'nested continuation', continuationTool: false, nestedBackground: true },
  ])('holds a $name behind the foreground ACP response', async ({ continuationTool, nestedBackground }) => {
    let releaseResponse = '';
    await withOfficialSession({
      model: { continuationTool, nestedBackground },
      persistApproval: nestedBackground,
      prepare: async ({ directory }) => {
        releaseResponse = join(directory, 'release-acp-response');
        const relay = join(directory, 'kimi-relay.mjs');
        // Only delay the foreground transport response; the official CLI still owns execution.
        await writeFile(relay, [
          "import { spawn } from 'node:child_process';",
          "import { existsSync } from 'node:fs';",
          "import { createInterface } from 'node:readline';",
          // Assert the real child environment without exposing inherited values.
          "if (['KIMI_MODEL', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY'].some(key => process.env[key] !== undefined)) throw new Error('Fixture process inherited a model override');",
          'const child = spawn(' + JSON.stringify(executable) + ", process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'] });",
          'const promptIds = new Set(); const pending = [];',
          "createInterface({ input: process.stdin }).on('line', line => {",
          '  const message = JSON.parse(line);',
          "  if (message.method === 'session/prompt') promptIds.add(message.id);",
          "  child.stdin.write(line + '\\n');",
          '});',
          "createInterface({ input: child.stdout }).on('line', line => {",
          '  const message = JSON.parse(line);',
          '  if (promptIds.has(message.id) && !existsSync(' + JSON.stringify(releaseResponse) + ')) pending.push(line);',
          "  else process.stdout.write(line + '\\n');",
          '});',
          'const timer = setInterval(() => {',
          '  if (!existsSync(' + JSON.stringify(releaseResponse) + ')) return;',
          "  for (const line of pending.splice(0)) process.stdout.write(line + '\\n');",
          '}, 10); timer.unref();',
          'child.stderr.pipe(process.stderr);',
          "child.on('exit', code => process.exit(code ?? 1));",
          "process.stdin.on('end', () => child.stdin.end());",
          "process.on('SIGTERM', () => child.kill('SIGTERM'));",
        ].join('\n'));
        return { executablePath: process.execPath, args: [relay] };
      },
    }, async ({ send, waitForTerminal, model, approvals, events }) => {
      try {
        await model.releaseBackground();
        const sent = send();
        await model.continuationRequested;
        model.releaseContinuation();
        await expect.poll(async () => (await model.readNativeEvents()).some(event => continuationTool
          ? event.type === 'interaction.request' && (event.request as { turnId?: number } | undefined)?.turnId === 1
          : event.type === 'turn.ended' && event.turnId === (nestedBackground ? 2 : 1) && event.reason === 'completed'),
        { timeout: 15_000 }).toBe(true);
        expect(approvals).toHaveLength(1);
        expect(events.some(event => event.kind === 'message-delta' && event.text === KIMI_FIXTURE_BACKGROUND)).toBe(false);
        expect(events.some(event => event.kind === 'turn-start' && event.startedBy === 'provider')).toBe(false);
        await writeFile(releaseResponse, 'ready');
        await sent;
        await waitForTerminal('parent');
        const expectedTurns = nestedBackground ? 2 : 1;
        await expect.poll(() => events.filter(event => event.kind === 'turn-start' && event.startedBy === 'provider').length,
          { timeout: 15_000 }).toBe(expectedTurns);
        const starts = events.filter((event): event is Extract<Event, { kind: 'turn-start' }> =>
          event.kind === 'turn-start' && event.startedBy === 'provider');
        for (const turn of starts) await waitForTerminal(turn.turnId);
        const markers = nestedBackground
          ? [KIMI_FIXTURE_BACKGROUND, KIMI_FIXTURE_NESTED_BACKGROUND] : [KIMI_FIXTURE_BACKGROUND];
        for (const [index, marker] of markers.entries()) {
          const output = events.filter(event => event.kind === 'message-delta' && event.text === marker);
          expect(output).toHaveLength(1);
          expect(output[0]).toMatchObject({ turnId: starts[index]!.turnId });
          expect(events.indexOf(output[0]!)).toBeLessThan(events.findIndex(event =>
            event.kind === 'turn-complete' && event.turnId === starts[index]!.turnId));
        }
        const stepSchema = z.object({ type: z.literal('context.append_loop_event'), agentId: z.literal('main'), event: z.object({
          type: z.literal('step.end'), uuid: z.string(), turnId: z.coerce.string(),
          usage: z.object({ inputOther: z.number(), inputCacheRead: z.number(), inputCacheCreation: z.number(), output: z.number() }),
        }) });
        const steps = (await model.readNativeEvents()).flatMap(record => {
          const parsed = stepSchema.safeParse(record);
          return parsed.success && parsed.data.event.turnId !== '0' ? [parsed.data.event] : [];
        });
        expect(steps.length).toBeGreaterThan(0);
        const observations = events.filter((event): event is Extract<Event, { kind: 'usage-observed' }> => event.kind === 'usage-observed');
        for (const { uuid, usage } of steps) {
          expect(observations.filter(event => event.observationId === `kimi-step:${uuid}`)).toEqual([expect.objectContaining({
            scope: 'turn_delta', tokens: expect.objectContaining({
              total: usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation + usage.output,
              input: usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation, output: usage.output,
            }),
          })]);
        }
        const contextOnly = observations.filter(event => event.context);
        expect(contextOnly.length).toBeGreaterThan(0);
        expect(contextOnly.every(event => event.tokens === undefined)).toBe(true);
        if (nestedBackground) expect(starts[1]).toMatchObject({ causedByTurnId: starts[0]!.turnId });
        if (continuationTool) {
          expect(approvals).toHaveLength(2);
          expect(await model.continuationExecuted()).toBe(true);
        }
      } finally { await writeFile(releaseResponse, 'ready'); }
    });
  }, 60_000);


  it.each([true, false])('routes native MCP approved=%s through host permission before the server effect', async approved => {
    const marker = 'KIMI_PUBLIC_MCP_RESULT';
    await withOfficialSession({
      approved,
      model: { mcpTool: true },
      mcpServers: async ({ directory, model }) => {
        const script = join(directory, 'mcp-fixture.mjs');
        const sentinel = join(model.workspace, 'mcp-executed');
        await writeFile(script, [
          "import { createInterface } from 'node:readline';",
          "import { writeFileSync } from 'node:fs';",
          "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
          "createInterface({ input: process.stdin }).on('line', line => {",
          '  const message = JSON.parse(line);',
          '  if (message.id === undefined) return;',
          '  let result;',
          "  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'kimi-boundary', version: '1.0.0' } };",
          "  else if (message.method === 'tools/list') result = { tools: [{ name: 'fixture_probe', description: 'Write the isolated test sentinel', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };",
          "  else if (message.method === 'tools/call') {",
          '    writeFileSync(' + JSON.stringify(sentinel) + ', "executed");',
          '    result = { content: [{ type: "text", text: ' + JSON.stringify(marker) + ' }] };',
          "  } else if (message.method === 'ping') result = {};",
          "  else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }",
          "  send({ jsonrpc: '2.0', id: message.id, result });",
          '});',
        ].join('\n'));
        return { fixture: { command: process.execPath, args: [script] } };
      },
    }, async ({ send, waitForTerminal, model, approvals }) => {
      await send();
      await waitForTerminal('parent', approved ? 'turn-complete' : 'turn-cancelled');
      expect(JSON.stringify(approvals)).toContain('fixture_probe');
      const sentinel = join(model.workspace, 'mcp-executed');
      if (approved) {
        expect(await readFile(sentinel, 'utf8')).toBe('executed');
        expect(model.getToolResponses().join('\n')).toContain(marker);
        expect(model.getRequestCount()).toBe(2);
      } else {
        await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(model.getRequestCount()).toBe(1);
      }
    });
  }, 60_000);

  it('stops a waiting native task when its public session is disposed', async () => {
    await withOfficialSession({}, async ({ send, waitForTerminal, model, events, runtime }) => {
      await send();
      await waitForTerminal('parent');
      expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: KIMI_FIXTURE_FOREGROUND }));
      const task = (await model.readNativeEvents()).find(event => event.type === 'task.started');
      const pid = (task?.info as { pid?: unknown } | undefined)?.pid;
      if (typeof pid !== 'number' || pid <= 0) throw new Error('Native task did not publish its owned pid');
      const isAlive = () => {
        try { process.kill(pid, 0); return true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      };
      expect(isAlive()).toBe(true);
      await runtime.dispose();
      await expect.poll(isAlive, { timeout: 5_000 }).toBe(false);
      await model.releaseBackground();
      model.releaseContinuation();
      expect(model.getRequestCount()).toBe(2);
      expect(events.some(event => event.kind === 'turn-start' && event.startedBy === 'provider')).toBe(false);
      expect(await model.continuationExecuted()).toBe(false);
    });
  }, 60_000);
});
