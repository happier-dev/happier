import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { AgentSessionInputFilesService } from '@happier-dev/plugin-sdk/agents/runtime';
import { createCodexAppServerRpcError } from './compatibility.js';

const UPLOAD_PATH = '.happier/uploads/messages/m1/screenshot.png';

const clientState = vi.hoisted(() => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const notificationHandlers = new Map<string, (params: unknown) => void | Promise<void>>();
  let turnStartCount = 0;
  let rejectStructuredTurnInput = false;
  const readInputLength = (params: unknown): number => {
    const record = params as Readonly<Record<string, unknown>> | null;
    return Array.isArray(record?.input) ? record.input.length : 0;
  };
  return {
    requests,
    reset() {
      requests.length = 0;
      notificationHandlers.clear();
      turnStartCount = 0;
      rejectStructuredTurnInput = false;
    },
    /** Native JSON-RPC rejection boundary for structured turn input. */
    rejectStructuredTurnInput() {
      rejectStructuredTurnInput = true;
    },
    async request(method: string, params?: unknown): Promise<unknown> {
      requests.push({ method, params });
      if (
        rejectStructuredTurnInput
        && (method === 'turn/start' || method === 'turn/steer')
        && readInputLength(params) > 1
      ) {
        throw createCodexAppServerRpcError({ method, code: -32602, message: 'Invalid params: unknown variant in `input`' });
      }
      if (method === 'thread/start' || method === 'thread/resume') {
        return { threadId: 'thread-1' };
      }
      if (method === 'turn/start') {
        turnStartCount += 1;
        return { turnId: `provider-turn-${turnStartCount}` };
      }
      if (method === 'turn/steer') {
        const record = params as Readonly<Record<string, unknown>>;
        if (typeof record.clientUserMessageId === 'string') {
          await notificationHandlers.get('item/started')?.({
            threadId: record.threadId,
            turnId: record.expectedTurnId,
            item: {
              id: `provider-user-message-${record.clientUserMessageId}`,
              type: 'userMessage',
              clientId: record.clientUserMessageId,
            },
          });
        }
        return {};
      }
      // Every other app-server call in this fixture is session bookkeeping that this contract does
      // not assert on; answering permissively keeps the fixture to the dispatch path under test.
      return {};
    },
    async notify(): Promise<void> {
      return undefined;
    },
    registerRequestHandler(): () => void {
      return () => undefined;
    },
    registerNotificationHandler(
      method: string,
      handler: (params: unknown) => void | Promise<void>,
    ): () => void {
      notificationHandlers.set(method, handler);
      return () => notificationHandlers.delete(method);
    },
    onExit(): () => void {
      return () => undefined;
    },
    readTurnInput(method: 'turn/start' | 'turn/steer'): readonly unknown[] {
      const request = requests.find((entry) => entry.method === method);
      if (!request) throw new Error(`Codex app-server never issued ${method}`);
      const record = request.params as Readonly<Record<string, unknown>> | null;
      return Array.isArray(record?.input) ? record.input : [];
    },
    readTurnInputs(method: 'turn/start' | 'turn/steer'): readonly (readonly unknown[])[] {
      return requests
        .filter((entry) => entry.method === method)
        .map((entry) => {
          const record = entry.params as Readonly<Record<string, unknown>> | null;
          return Array.isArray(record?.input) ? record.input : [];
        });
    },
  };
});

vi.mock('./client.js', () => ({
  createCodexAppServerClient: vi.fn(async () => ({
    launchFeatures: {
      realtimeConversationAdvertised: false,
    },
    request: clientState.request,
    notify: clientState.notify,
    registerRequestHandler: clientState.registerRequestHandler,
    registerNotificationHandler: clientState.registerNotificationHandler,
    onExit: clientState.onExit,
    dispose: vi.fn(async () => undefined),
  })),
  isCodexAppServerOversizedJsonFrameError: vi.fn(() => false),
  resolveCodexHome: (env: Readonly<Record<string, string | undefined>>) =>
    env.CODEX_HOME ?? '/home/test/.codex',
}));

import { createCodexAppServerClient } from './client.js';
import { createCodexNativeAppServerSessionRuntime } from './native.js';
import { createCodexAppServerRuntime } from './runtime.js';

function createRuntime(inputFiles?: AgentSessionInputFilesService) {
  const exec = Object.freeze({}) as unknown as ExecService;
  return createCodexAppServerRuntime({
    host: {
      ...(inputFiles ? { inputFiles } : {}),
      baseProcessEnv: {},
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
      accountUsage: {
        resolveSourceContext: async () => null,
        recordSnapshot: async () => ({ status: 'recorded' }),
        adoptProvisionalRecord: async () => ({
          status: 'adopted',
          fromRecordId: 'paug_v1_from',
          toRecordId: 'paug_v1_to',
        }),
      },
      createClient: async (request) => await createCodexAppServerClient({
        exec,
        cwd: request.cwd,
        processEnv: request.processEnv,
        configOverrides: request.configOverrides,
        disableUserMcpServers: request.disableUserMcpServers,
      }),
    },
    directory: '/workspace',
    happierSessionId: 'session-1',
  });
}

const STRUCTURED_INPUT = {
  v: 1,
  vendorPluginMentions: [
    { vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' },
  ],
  skillMentions: [
    { id: 'review', name: 'review', path: '/skills/review/SKILL.md', displayName: 'Review' },
  ],
  imageInputs: [
    {
      id: `localImage:${UPLOAD_PATH}`,
      kind: 'localImage',
      mimeType: 'image/png',
      path: UPLOAD_PATH,
      provenance: { kind: 'sessionAttachmentUpload' },
    },
  ],
} as const;

describe('Codex app-server structured input dispatch', () => {
  beforeEach(() => {
    clientState.reset();
  });

  it('delivers browser images through the verified host service without a text-only fallback', async () => {
    const browserInput = { v: 1, imageInputs: [{ id: 'browser-image', kind: 'localImage',
      path: '.happier/uploads/artifacts/session-1/capture/screen.png', mimeType: 'image/png',
      sha256: 'a'.repeat(64), sizeBytes: 68,
      provenance: { kind: 'browserSessionMedia', sessionId: 'session-1', storage: 'daemon' },
    }] };
    // Public host service boundary; byte verification itself is exercised at the host owner.
    const runtime = createCodexNativeAppServerSessionRuntime(createRuntime({
      readVerifiedImage: async () => ({ url: 'data:image/png;base64,verified-pixels', mimeType: 'image/png' }),
    }), 'session-1');
    await expect(runtime.send({ inputIds: ['browser-1'], input: { text: 'Inspect', structuredInput: browserInput },
      delivery: { kind: 'newTurn', turnId: 'turn-browser' } })).resolves.toEqual({ status: 'admitted' });
    expect(clientState.readTurnInput('turn/start')).toEqual([
      { type: 'text', text: 'Inspect' }, { type: 'image', url: 'data:image/png;base64,verified-pixels' },
    ]);
  });

  it('forwards skill mentions, vendor plugin mentions and verified image attachments to turn/start', async () => {
    const runtime = createCodexNativeAppServerSessionRuntime(createRuntime(), 'session-1');

    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'Use @gmail and $review', structuredInput: STRUCTURED_INPUT },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    expect(clientState.readTurnInput('turn/start')).toEqual([
      { type: 'text', text: 'Use @gmail and $review' },
      { type: 'mention', name: 'Gmail', path: 'plugin://gmail@openai-curated' },
      { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
      { type: 'localImage', path: UPLOAD_PATH },
    ]);
  });

  it('forwards structured input on a steer delivery', async () => {
    const runtime = createCodexNativeAppServerSessionRuntime(createRuntime(), 'session-1');

    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'first prompt' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    await expect(runtime.send({
      inputIds: ['input-2'],
      input: { text: 'also look at $review', structuredInput: STRUCTURED_INPUT },
      delivery: { kind: 'steer', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    expect(clientState.readTurnInput('turn/steer')).toEqual([
      { type: 'text', text: 'also look at $review' },
      { type: 'mention', name: 'Gmail', path: 'plugin://gmail@openai-curated' },
      { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
      { type: 'localImage', path: UPLOAD_PATH },
    ]);
  });

  it('refuses unsupported image input instead of retrying a text-only turn', async () => {
    clientState.rejectStructuredTurnInput();
    const runtime = createCodexNativeAppServerSessionRuntime(createRuntime(), 'session-1');

    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'Use @gmail and $review', structuredInput: STRUCTURED_INPUT },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toMatchObject({ status: 'unsupported' });

    expect(clientState.readTurnInputs('turn/start')).toHaveLength(1);
  });

  it('refuses unsupported image input instead of retrying text-only steer', async () => {
    const runtime = createCodexNativeAppServerSessionRuntime(createRuntime(), 'session-1');

    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'first prompt' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    clientState.rejectStructuredTurnInput();
    await expect(runtime.send({
      inputIds: ['input-2'],
      input: { text: 'also look at $review', structuredInput: STRUCTURED_INPUT },
      delivery: { kind: 'steer', turnId: 'turn-1' },
    })).resolves.toMatchObject({ status: 'unsupported' });

    expect(clientState.readTurnInputs('turn/steer')).toHaveLength(1);
  });

  it('surfaces rejected skill and plugin input without sending a text-only new turn', async () => {
    clientState.rejectStructuredTurnInput();
    const runtime = createCodexNativeAppServerSessionRuntime(createRuntime(), 'session-1');
    const input = {
      v: 1,
      vendorPluginMentions: STRUCTURED_INPUT.vendorPluginMentions,
      skillMentions: STRUCTURED_INPUT.skillMentions,
    };

    await expect(runtime.send({
      inputIds: ['input-mentions'],
      input: { text: 'Use @gmail and $review', structuredInput: input },
      delivery: { kind: 'newTurn', turnId: 'turn-mentions' },
    })).resolves.toMatchObject({ status: 'unsupported', diagnostic: { code: 'codex_send_unsupported', message: 'codex_structured_input_rejected' } });
    expect(clientState.readTurnInputs('turn/start')).toEqual([[
      { type: 'text', text: 'Use @gmail and $review' },
      { type: 'mention', name: 'Gmail', path: 'plugin://gmail@openai-curated' },
      { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
    ]]);
    await expect(runtime.send({
      inputIds: ['input-recovery'],
      input: { text: 'plain recovery' },
      delivery: { kind: 'newTurn', turnId: 'turn-recovery' },
    })).resolves.toEqual({ status: 'admitted' });
  });

  it('surfaces rejected skill and plugin input without sending a text-only steer', async () => {
    const runtime = createCodexNativeAppServerSessionRuntime(createRuntime(), 'session-1');
    await runtime.send({
      inputIds: ['input-primary'],
      input: { text: 'first prompt' },
      delivery: { kind: 'newTurn', turnId: 'turn-primary' },
    });
    clientState.rejectStructuredTurnInput();

    await expect(runtime.send({
      inputIds: ['input-mentions'],
      input: { text: 'Use @gmail and $review', structuredInput: {
        v: 1,
        vendorPluginMentions: STRUCTURED_INPUT.vendorPluginMentions,
        skillMentions: STRUCTURED_INPUT.skillMentions,
      } },
      delivery: { kind: 'steer', turnId: 'turn-primary' },
    })).resolves.toMatchObject({ status: 'unsupported', diagnostic: { code: 'codex_send_unsupported', message: 'codex_structured_input_rejected' } });
    expect(clientState.readTurnInputs('turn/steer')).toEqual([[
      { type: 'text', text: 'Use @gmail and $review' },
      { type: 'mention', name: 'Gmail', path: 'plugin://gmail@openai-curated' },
      { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
    ]]);
    await expect(runtime.send({
      inputIds: ['input-recovery'],
      input: { text: 'plain recovery' },
      delivery: { kind: 'steer', turnId: 'turn-primary' },
    })).resolves.toEqual({ status: 'admitted' });
  });

  it('sends a text-only turn input when the runtime input carries no structured input', async () => {
    const runtime = createCodexNativeAppServerSessionRuntime(createRuntime(), 'session-1');

    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'plain prompt' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    expect(clientState.readTurnInput('turn/start')).toEqual([
      { type: 'text', text: 'plain prompt' },
    ]);
  });
});
