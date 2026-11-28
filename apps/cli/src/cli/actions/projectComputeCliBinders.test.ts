import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { getActionSpec } from '@happier-dev/protocol';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';

import {
  bindContextualActionToolInput,
  projectSessionBoundActionToolInputSchema,
  resolveSessionDefaultWorkspaceAddress,
} from '@/agent/tools/happierTools/actionToolContext';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { resolveSessionNativeToolDescriptors } from '@/agent/tools/happierTools/resolveSessionNativeToolBridge';
import { prepareHappierMcpToolInventory } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { findCompiledActionCliCommand } from './compiledCommands';
import { runCompiledActionCliCommand } from './executeCommand';
import { composeActionCliInput, parseActionCliCommandInput } from './parseCommandInput';

const workspace = {
  serverId: 'home-1',
  workspaceId: 'ws-1',
  machineId: 'laptop-1',
  rootPath: '/repo',
} as const;

function composeCommand(argv: readonly string[]) {
  const command = findCompiledActionCliCommand(argv);
  if (!command) throw new Error(`No compiled command matched: ${argv.join(' ')}`);
  const parsed = parseActionCliCommandInput(command, argv);
  if (!parsed.ok) return parsed;
  return composeActionCliInput({
    parsed,
    canonicalSchema: command.spec.inputSchema,
    wholeInputSchema: command.wholeInputSchema,
    callerSchema: command.callerSchema,
    bindInput: command.spec.cli?.bindInput,
    context: {
      actionId: command.actionId,
      invocationId: 'cli-test-invocation',
      commandPath: command.path,
    },
  });
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('Project compute CLI binders', () => {
  it('parses `happier project script run <name> [--on <machineId>]` into canonical projects.script.run input', () => {
    const onWorker = composeCommand([
      'project', 'script', 'run', 'test',
      '--on', 'worker-1',
      '--workspace-json', JSON.stringify(workspace),
    ]);
    expect(onWorker).toMatchObject({
      ok: true,
      input: {
        workspace,
        selection: { kind: 'named', name: 'test' },
        choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-1' } },
      },
    });

    const defaultPlacement = composeCommand([
      'project', 'script', 'run', 'typecheck',
      '--workspace-json', JSON.stringify(workspace),
    ]);
    expect(defaultPlacement).toMatchObject({
      ok: true,
      input: {
        workspace,
        selection: { kind: 'named', name: 'typecheck' },
      },
    });
    if (defaultPlacement.ok) {
      expect(defaultPlacement.input).not.toHaveProperty('choice');
    }
  });

  it('preserves backwards-compatible `--selection-json` and `--choice-json` flags on projects.script.run and rejects duplicates', () => {
    const legacy = composeCommand([
      'project', 'script', 'run',
      '--workspace-json', JSON.stringify(workspace),
      '--selection-json', JSON.stringify({ kind: 'named', name: 'lint' }),
      '--choice-json', JSON.stringify({ kind: 'primary' }),
    ]);
    expect(legacy).toMatchObject({
      ok: true,
      input: {
        workspace,
        selection: { kind: 'named', name: 'lint' },
        choice: { kind: 'primary' },
      },
    });

    const duplicateSelection = composeCommand([
      'project', 'script', 'run', 'lint',
      '--workspace-json', JSON.stringify(workspace),
      '--selection-json', JSON.stringify({ kind: 'named', name: 'lint' }),
    ]);
    expect(duplicateSelection.ok).toBe(false);

    const duplicatePlacement = composeCommand([
      'project', 'script', 'run', 'lint',
      '--on', 'worker-1',
      '--choice-json', JSON.stringify({ kind: 'primary' }),
      '--workspace-json', JSON.stringify(workspace),
    ]);
    expect(duplicatePlacement.ok).toBe(false);
  });

  it('parses `happier project compute exec [--on <machineId>] [--cwd <dir>] -- <executable> [args...]` cleanly', () => {
    const withArgsAndFlags = composeCommand([
      'project', 'compute', 'exec',
      '--on', 'worker-nl1',
      '--cwd', '/repo/apps/cli',
      '--workspace-json', JSON.stringify(workspace),
      '--', 'pnpm', 'test', '--maxWorkers=1',
    ]);
    expect(withArgsAndFlags).toMatchObject({
      ok: true,
      input: {
        workspace,
        executable: 'pnpm',
        argv: ['test', '--maxWorkers=1'],
        cwd: '/repo/apps/cli',
        choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-nl1' } },
      },
    });

    const defaultCwdAndEmptyArgs = composeCommand([
      'project', 'compute', 'exec',
      '--workspace-json', JSON.stringify(workspace),
      '--', 'uname',
    ]);
    expect(defaultCwdAndEmptyArgs).toMatchObject({
      ok: true,
      input: {
        workspace,
        executable: 'uname',
        argv: [],
        cwd: '/repo',
      },
    });
  });

  it('preserves backwards-compatible flags, supports --input-json composition, and rejects conflicting executable/argv or blocked env keys', () => {
    const legacy = composeCommand([
      'project', 'compute', 'exec',
      '--workspace-json', JSON.stringify(workspace),
      '--executable', 'printf',
      '--argv-json', JSON.stringify(['a b', 'c']),
      '--cwd', '/repo/subdir',
      '--env-json', JSON.stringify({ CI: '1', NODE_ENV: 'test' }),
    ]);
    expect(legacy).toMatchObject({
      ok: true,
      input: {
        workspace,
        executable: 'printf',
        argv: ['a b', 'c'],
        cwd: '/repo/subdir',
        env: { CI: '1', NODE_ENV: 'test' },
      },
    });

    // Composes --input-json with friendly --on flag cleanly.
    const composedWithInputJson = composeCommand([
      'project', 'compute', 'exec',
      '--input-json', JSON.stringify({
        workspace,
        executable: 'pnpm',
        argv: ['test'],
        cwd: '/repo',
      }),
      '--on', 'worker-nl1',
    ]);
    expect(composedWithInputJson).toMatchObject({
      ok: true,
      input: {
        workspace,
        executable: 'pnpm',
        argv: ['test'],
        cwd: '/repo',
        choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-nl1' } },
      },
    });

    // Rejects conflicting --executable with positional executable.
    const conflictingExecutable = composeCommand([
      'project', 'compute', 'exec',
      '--workspace-json', JSON.stringify(workspace),
      '--executable', 'pnpm',
      '--', 'npm', 'test',
    ]);
    expect(conflictingExecutable.ok).toBe(false);

    // Rejects conflicting --argv-json with variadic positional args.
    const conflictingArgv = composeCommand([
      'project', 'compute', 'exec',
      '--workspace-json', JSON.stringify(workspace),
      '--argv-json', JSON.stringify(['test']),
      '--', 'pnpm', 'lint',
    ]);
    expect(conflictingArgv.ok).toBe(false);

    // Rejects blocked/invalid env keys.
    for (const badEnv of [{ 'BAD=NAME': '1' }, { PATH: '/tmp' }, { LD_PRELOAD: '/tmp/x.so' }, { HAPPIER_SERVER_URL: 'http://evil' }]) {
      const invalidEnv = composeCommand([
        'project', 'compute', 'exec',
        '--workspace-json', JSON.stringify(workspace),
        '--executable', 'env',
        '--env-json', JSON.stringify(badEnv),
      ]);
      expect(invalidEnv.ok, JSON.stringify(badEnv)).toBe(false);
    }
  });

  it('binds session workspace contextualDefaults end-to-end across MCP inventory, native tool descriptors, and live bridge dispatch', async () => {
    const resolvedFromMetadata = resolveSessionDefaultWorkspaceAddress({
      serverId: workspace.serverId,
      metadata: { workspaceId: workspace.workspaceId, machineId: workspace.machineId, path: workspace.rootPath },
    });
    expect(resolvedFromMetadata).toEqual(workspace);

    // 1. Verify schema projection & binding for all four actions.
    const context = {
      defaultSessionId: 'session-1',
      defaultSessionMachineId: workspace.machineId,
      defaultSessionRootPath: workspace.rootPath,
      defaultSessionWorkspace: workspace,
    };
    for (const [actionId, input, expectedWorkspace] of [
      ['projects.script.run', { selection: { kind: 'named', name: 'test' } }, workspace],
      ['projects.compute.exec', { executable: 'pnpm', argv: ['test'], cwd: '/repo' }, workspace],
      ['projects.worker.preferences.get', {}, { serverId: workspace.serverId, refId: workspace.workspaceId }],
      ['projects.worker.status', { destination: { kind: 'machine', machineId: 'worker-1' }, purpose: 'finite' }, { serverId: workspace.serverId, refId: workspace.workspaceId }],
    ] as const) {
      const schema = getActionSpec(actionId).inputSchema;
      const projected = projectSessionBoundActionToolInputSchema({ actionId, inputSchema: schema, context }) as z.ZodMiniType;
      expect(projected.safeParse(input).success, actionId).toBe(true);
      expect(schema.safeParse(input).success, actionId).toBe(false);
      const bound = bindContextualActionToolInput({ actionId, input, context });
      expect(schema.parse(bound)).toMatchObject({ ...input, workspace: expectedWorkspace });
      expect(projectSessionBoundActionToolInputSchema({ actionId, inputSchema: schema, context: {} })).toBe(schema);
    }

    // 2. Live MCP tool inventory & native tool descriptors expose `workspace` as optional when sessionWorkspace is bound.
    const mcpInventory = prepareHappierMcpToolInventory({
      sessionId: 'session-1',
      sessionMachineId: workspace.machineId,
      sessionRootPath: workspace.rootPath,
      sessionWorkspace: workspace,
      inventory: createHappierToolInventory({
        surface: 'agent',
        requiredDirectActionIds: ['projects.script.run', 'projects.compute.exec'],
      }),
    });
    for (const toolName of ['projects_script_run', 'projects_compute_exec'] as const) {
      const registration = mcpInventory.registrations.find((entry) => entry.tool.name === toolName);
      expect(registration, toolName).toBeDefined();
      const jsonSchema = zodSchemaToJsonSchemaObject(registration!.meta.inputSchema);
      expect((jsonSchema.required as string[] | undefined) ?? [], toolName).not.toContain('workspace');
    }

    const prevActionsSettingsEnv = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    let nativeTools: ReturnType<typeof resolveSessionNativeToolDescriptors>;
    try {
      nativeTools = resolveSessionNativeToolDescriptors({
        accountSettings: {
          actionsSettingsV1: {
            v: 1,
            actions: {
              'projects.script.run': { toolExposureModes: { agent: 'direct' } },
              'projects.compute.exec': { toolExposureModes: { agent: 'direct' } },
            },
          },
        },
        isServerFeatureEnabled: () => true,
        sessionId: 'session-1',
        sessionMachineId: workspace.machineId,
        sessionRootPath: workspace.rootPath,
        sessionWorkspace: workspace,
        memoryRecallGuidanceEnabled: false,
      });
    } finally {
      if (prevActionsSettingsEnv !== undefined) {
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = prevActionsSettingsEnv;
      }
    }
    for (const toolName of ['projects_script_run', 'projects_compute_exec'] as const) {
      const descriptor = nativeTools.find((entry) => entry.name === toolName);
      expect(descriptor, toolName).toBeDefined();
      const schemaObj = descriptor!.inputSchema as Readonly<{ required?: readonly string[] }>;
      expect(schemaObj.required ?? [], toolName).not.toContain('workspace');
    }

    // 3. Composed live bridge dispatch: omit `workspace` in both direct MCP tool calls and `action_execute`.
    const executed: Array<Readonly<{ actionId: string; input: unknown }>> = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      requiredDirectActionIds: ['projects.script.run', 'projects.compute.exec'],
      defaultSessionMachineId: workspace.machineId,
      defaultSessionRootPath: workspace.rootPath,
      defaultSessionWorkspace: workspace,
      executor: {
        execute: async (actionId, input) => {
          const spec = getActionSpec(actionId);
          const parsed = spec.inputSchema.parse(input);
          executed.push({ actionId, input: parsed });
          return { ok: true, result: { accepted: true, actionId } };
        },
      },
    });

    const scriptRunResult = await dispatchBuiltInHappierTool({
      toolName: 'projects_script_run',
      args: { selection: { kind: 'named', name: 'test' } },
      sessionId: 'session-1',
      sessionMachineId: workspace.machineId,
      sessionRootPath: workspace.rootPath,
      sessionWorkspace: workspace,
      surface: 'agent',
      requiredDirectActionIds: ['projects.script.run', 'projects.compute.exec'],
      deps: {
        executeActionByToolName: bridge.executeActionByToolName,
        changeTitle: async () => ({ success: true }),
      },
    });
    expect(scriptRunResult).toMatchObject({ ok: true, result: { accepted: true, actionId: 'projects.script.run' } });

    const computeExecResult = await dispatchBuiltInHappierTool({
      toolName: 'projects_compute_exec',
      args: { executable: 'pnpm', argv: ['test'], cwd: '/repo', env: { CI: '1' } },
      sessionId: 'session-1',
      sessionMachineId: workspace.machineId,
      sessionRootPath: workspace.rootPath,
      sessionWorkspace: workspace,
      surface: 'agent',
      requiredDirectActionIds: ['projects.script.run', 'projects.compute.exec'],
      deps: {
        executeActionByToolName: bridge.executeActionByToolName,
        changeTitle: async () => ({ success: true }),
      },
    });
    expect(computeExecResult).toMatchObject({ ok: true, result: { accepted: true, actionId: 'projects.compute.exec' } });

    expect(executed).toEqual([
      {
        actionId: 'projects.script.run',
        input: { workspace, selection: { kind: 'named', name: 'test' } },
      },
      {
        actionId: 'projects.compute.exec',
        input: { workspace, executable: 'pnpm', argv: ['test'], cwd: '/repo', env: { CI: '1' } },
      },
    ]);
  });

  it('executes advertised CLI commands end-to-end without --workspace-json in Session MCP and standalone checkouts, and fails closed outside a checkout', async () => {
    const stdoutChunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: unknown,
      encodingOrCb?: unknown,
      maybeCb?: unknown,
    ) => {
      stdoutChunks.push(String(chunk));
      const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
      if (typeof cb === 'function') (cb as (err?: Error | null) => void)(null);
      return true;
    }) as typeof process.stdout.write);

    try {

    const scriptCommand = findCompiledActionCliCommand(['project', 'script', 'run', 'test'])!;
    const execCommand = findCompiledActionCliCommand(['project', 'compute', 'exec', '--', 'pnpm', 'test'])!;

    // 1. Inside Session MCP: workspace is omitted locally so Session MCP fills defaultSessionWorkspace.
    const mcpCalls: Array<Readonly<{ actionId: string; input: unknown }>> = [];
    await runCompiledActionCliCommand({
      command: scriptCommand,
      argv: ['project', 'script', 'run', 'test', '--on', 'worker-1', '--json'],
      deps: {
        hasSessionMcpContextFn: () => true,
        executeSessionMcpActionFn: async (actionId, input) => {
          mcpCalls.push({ actionId, input });
          return { ok: true, result: { ok: true } };
        },
      },
    });
    await runCompiledActionCliCommand({
      command: execCommand,
      argv: ['project', 'compute', 'exec', '--on', 'worker-1', '--', 'pnpm', 'test', '--json'],
      deps: {
        hasSessionMcpContextFn: () => true,
        getCwdFn: () => '/repo/apps/cli',
        executeSessionMcpActionFn: async (actionId, input) => {
          mcpCalls.push({ actionId, input });
          return { ok: true, result: { ok: true } };
        },
      },
    });
    expect(mcpCalls).toEqual([
      {
        actionId: 'projects.script.run',
        input: {
          selection: { kind: 'named', name: 'test' },
          choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-1' } },
        },
      },
      {
        actionId: 'projects.compute.exec',
        input: {
          executable: 'pnpm',
          argv: ['test', '--json'],
          cwd: '/repo/apps/cli',
          choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-1' } },
        },
      },
    ]);

    // 2. Standalone CLI inside a registered checkout: resolves workspace from cwd and executes canonically.
    const standaloneCalls: Array<Readonly<{ actionId: string; input: unknown }>> = [];
    const fakeCredentials = {
      token: 'standalone-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    };
    const standaloneDeps = {
      hasSessionMcpContextFn: () => false,
      getCwdFn: () => '/repo/apps/cli',
      readCredentialsFn: async () => fakeCredentials,
      createServerFeaturesSnapshotStoreFn: () => ({
        refresh: async () => ({ status: 'ready' as const, features: { features: {}, capabilities: {} } }),
        getSnapshot: () => undefined,
      }) as never,
      resolveWorkspaceForCwdFn: async () => ({ ok: true as const, workspace }),
      createExecutorFn: async () => ({
        execute: async (actionId: string, input: unknown) => {
          standaloneCalls.push({ actionId, input });
          return { ok: true as const, result: { ok: true } };
        },
        resolveSessionTarget: async () => ({ ok: false as const, code: 'session_not_found' as const }),
      }),
    };

    await runCompiledActionCliCommand({
      command: scriptCommand,
      argv: ['project', 'script', 'run', 'test', '--on', 'worker-nl1', '--json'],
      deps: standaloneDeps,
    });
    await runCompiledActionCliCommand({
      command: execCommand,
      argv: ['project', 'compute', 'exec', '--json', '--', 'pnpm', 'typecheck'],
      deps: standaloneDeps,
    });
    expect(standaloneCalls).toEqual([
      {
        actionId: 'projects.script.run',
        input: {
          workspace,
          selection: { kind: 'named', name: 'test' },
          choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-nl1' } },
        },
      },
      {
        actionId: 'projects.compute.exec',
        input: {
          workspace,
          executable: 'pnpm',
          argv: ['typecheck'],
          cwd: '/repo/apps/cli',
        },
      },
    ]);

    // 3. Standalone CLI outside a registered checkout: fails closed without invoking executor.
    const outsideCalls: unknown[] = [];
    stdoutChunks.length = 0;
    await runCompiledActionCliCommand({
      command: scriptCommand,
      argv: ['project', 'script', 'run', 'test', '--json'],
      deps: {
        ...standaloneDeps,
        resolveWorkspaceForCwdFn: async () => ({
          ok: false as const,
          errorCode: 'invalid_arguments',
          errorMessage: 'No registered project checkout found for the current directory.',
        }),
        createExecutorFn: async () => ({
          execute: async (actionId: string, input: unknown) => {
            outsideCalls.push({ actionId, input });
            return { ok: true as const, result: { ok: true } };
          },
          resolveSessionTarget: async () => ({ ok: false as const, code: 'session_not_found' as const }),
        }),
      },
    });
    expect(outsideCalls).toEqual([]);
    expect(JSON.parse(stdoutChunks.join(''))).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments' },
    });
    } finally {
      writeSpy.mockRestore();
      process.exitCode = undefined;
    }
  });
});
