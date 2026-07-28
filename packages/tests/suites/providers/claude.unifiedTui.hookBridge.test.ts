/**
 * Provider E2E (G4–G5 / P7.1): AskUserQuestion + ExitPlanMode + multi-pending permission isolation are
 * answered through the REAL Lane F hook/permission bridge — NEVER by typing into the Claude TUI screen.
 *
 * The "fake hook transport" is the genuine boundary: `handlePermissionHook(data)` is Claude firing a hook
 * inbound, and the resolved Promise is the hook response Happier sends back to Claude. The permission RPC
 * handler is the UI -> bridge answer path. The REAL `ClaudeLocalPermissionBridge` runs unmodified; only
 * the session is the canonical `createPermissionHandlerSessionStub` boundary double. No terminal-control
 * port is constructed here — proving the answer path is hook-driven, not screen-driven.
 *
 * The real bridge transitively imports the heavy CLI backend graph. This test loads that bridge through
 * `vi.importActual` behind the small typed boundary below so the runtime-included provider suite also
 * participates in the `packages/tests` typecheck without compiling unrelated CLI terminal UI modules.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type PermissionRpcHandler = (payload: {
  id: string;
  approved: boolean;
  answers?: Record<string, string>;
  mode?: string;
}) => Promise<unknown> | unknown;

type FakePermissionClient = {
  rpcHandlerManager: {
    getHandler: (name: string) => PermissionRpcHandler | undefined;
  };
  agentState: {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
  };
  getMetadataSnapshot: () => {
    sessionModeOverrideV1?: unknown;
  };
};

type PermissionSessionStub = Readonly<{
  session: unknown;
  client: FakePermissionClient;
}>;

type ClaudePermissionBridge = {
  activate: () => void;
  dispose: () => void;
  handlePermissionHook: (payload: Record<string, unknown>) => Promise<unknown>;
};

type ClaudePermissionBridgeConstructor = new (
  session: unknown,
  options: { responseTimeoutMs: number },
) => ClaudePermissionBridge;

type BridgeModule = Readonly<{
  ClaudeLocalPermissionBridge: ClaudePermissionBridgeConstructor;
}>;

type PermissionHandlerTestkitModule = Readonly<{
  createPermissionHandlerSessionStub: (sessionId: string) => PermissionSessionStub;
  createPermissionHandlerSessionStubWithMetadata: (params: Readonly<{
    sessionId: string;
    metadata: Record<string, unknown>;
  }>) => PermissionSessionStub;
}>;

const LONG_TIMEOUT_MS = 600_000;

let ClaudeLocalPermissionBridge: ClaudePermissionBridgeConstructor | null = null;
let createPermissionHandlerSessionStub: PermissionHandlerTestkitModule['createPermissionHandlerSessionStub'] | null = null;
let createPermissionHandlerSessionStubWithMetadata:
  PermissionHandlerTestkitModule['createPermissionHandlerSessionStubWithMetadata'] | null = null;

const liveBridges: ClaudePermissionBridge[] = [];

function requireRuntimeModules(): {
  Bridge: ClaudePermissionBridgeConstructor;
  createSessionStub: PermissionHandlerTestkitModule['createPermissionHandlerSessionStub'];
  createSessionStubWithMetadata: PermissionHandlerTestkitModule['createPermissionHandlerSessionStubWithMetadata'];
} {
  if (!ClaudeLocalPermissionBridge || !createPermissionHandlerSessionStub || !createPermissionHandlerSessionStubWithMetadata) {
    throw new Error('Claude hook bridge runtime modules were not loaded');
  }
  return {
    Bridge: ClaudeLocalPermissionBridge,
    createSessionStub: createPermissionHandlerSessionStub,
    createSessionStubWithMetadata: createPermissionHandlerSessionStubWithMetadata,
  };
}

function startBridge(session: unknown): ClaudePermissionBridge {
  const { Bridge } = requireRuntimeModules();
  const bridge = new Bridge(session, { responseTimeoutMs: LONG_TIMEOUT_MS });
  bridge.activate();
  liveBridges.push(bridge);
  return bridge;
}

function permissionRpc(client: FakePermissionClient) {
  const handler = client.rpcHandlerManager.getHandler('permission');
  if (!handler) throw new Error('permission RPC handler not registered');
  return handler;
}

/** Resolves to true only if `promise` has NOT settled by the next macrotask. */
async function isStillPending(promise: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol('pending');
  const settled = new Promise<typeof sentinel>((resolve) => setTimeout(() => resolve(sentinel), 0));
  const winner = await Promise.race([promise.then(() => 'settled' as const), settled]);
  return winner === sentinel;
}

afterEach(() => {
  for (const bridge of liveBridges.splice(0)) bridge.dispose();
});

beforeAll(async () => {
  const bridgeModule = await vi.importActual<BridgeModule>(
    '@/backends/claude/localPermissions/localPermissionBridge',
  );
  const testkitModule = await vi.importActual<PermissionHandlerTestkitModule>(
    '@/backends/claude/utils/permissionHandler.testkit',
  );
  ClaudeLocalPermissionBridge = bridgeModule.ClaudeLocalPermissionBridge;
  createPermissionHandlerSessionStub = testkitModule.createPermissionHandlerSessionStub;
  createPermissionHandlerSessionStubWithMetadata = testkitModule.createPermissionHandlerSessionStubWithMetadata;
});

describe('Claude Unified hook bridge answers (G4)', () => {
  it('G4: projects canonical AskUserQuestion arrays to Claude scalar updatedInput answers (no screen typing)', async () => {
    const { createSessionStub } = requireRuntimeModules();
    const { session, client } = createSessionStub('e2e-askuserquestion');
    const bridge = startBridge(session);

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which color do you prefer?' }] },
      tool_use_id: 'toolu_ask_1',
    });

    await Promise.resolve();
    await permissionRpc(client)({
      id: 'toolu_ask_1',
      approved: true,
      answers: { 'Which color do you prefer?': 'RED' },
    });

    await expect(pending).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          questions: [{ question: 'Which color do you prefer?' }],
          answers: { 'Which color do you prefer?': 'RED' },
        },
      },
    });
  });

  it('G4: ExitPlanMode approval synthesizes a setMode update and clears plan-mode metadata', async () => {
    const { createSessionStubWithMetadata } = requireRuntimeModules();
    const { session, client } = createSessionStubWithMetadata({
      sessionId: 'e2e-exitplanmode',
      metadata: { sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } },
    });
    const bridge = startBridge(session);

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'ship the change' },
      tool_use_id: 'toolu_exit_1',
    });

    await Promise.resolve();
    // The UI supplies only the follow-up mode; the bridge synthesizes the setMode update over the hook.
    await permissionRpc(client)({ id: 'toolu_exit_1', approved: true, mode: 'default' });

    await expect(pending).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'default' }],
        },
      },
    });

    // Plan-mode metadata is cleared (follow-up mode travels via the hook, not TUI keystrokes).
    expect(client.getMetadataSnapshot().sessionModeOverrideV1).toMatchObject({ modeId: null });
  });
});

describe('Claude Unified hook bridge multi-pending isolation (G5)', () => {
  it('G5: approving one permission request leaves an unrelated request pending', async () => {
    const { createSessionStub } = requireRuntimeModules();
    const { session, client } = createSessionStub('e2e-multi-pending');
    const bridge = startBridge(session);

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/a.txt', content: 'a' },
      tool_use_id: 'toolu_first',
    });
    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/b.txt', content: 'b' },
      tool_use_id: 'toolu_second',
    });

    await Promise.resolve();
    expect(client.agentState.requests.toolu_first).toBeDefined();
    expect(client.agentState.requests.toolu_second).toBeDefined();

    // Approve only the first request.
    await permissionRpc(client)({ id: 'toolu_first', approved: true });

    await expect(first).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    expect(client.agentState.completedRequests.toolu_first).toMatchObject({ status: 'approved' });

    // The unrelated request is untouched: still pending, not auto-resolved.
    expect(client.agentState.requests.toolu_second).toBeDefined();
    expect(client.agentState.completedRequests.toolu_second).toBeUndefined();
    expect(await isStillPending(second)).toBe(true);
  });

  it('G5: a stale/unknown explicit request id returns a typed not-found, never a false approval', async () => {
    const { createSessionStub } = requireRuntimeModules();
    const { session, client } = createSessionStub('e2e-stale-id');
    startBridge(session);

    // The router maps the bridge's "unhandled" outcome to a typed failure — never a success/approval.
    const result = await permissionRpc(client)({ id: 'toolu_never_existed', approved: true });
    expect(result).toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
  });
});
