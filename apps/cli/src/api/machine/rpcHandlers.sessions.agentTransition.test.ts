import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionInputAdmissionResultV1 } from '@happier-dev/protocol';

import type { RpcHandler } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';

/**
 * The registered machine-RPC boundary for `session.agentTransition`.
 *
 * Protected Session input is admitted by the canonical message owner, and for
 * an E2EE Session that owner can only use the AUTHENTICATED MACHINE admission
 * transport — the Account HTTP route cannot carry the host-derived equality
 * assertion. `ApiMachine` owns that transport, but only the registration that
 * actually threads it can put it in the coordinator's hands.
 *
 * These tests therefore run the REAL coordinator and the REAL
 * `sendSessionMessage` behind the REAL machine registration, with only genuine
 * system boundaries doubled (session HTTP transport, idle/stop/cutover/resume
 * session RPC, transcript lookup, Agent catalog, replay context, and the
 * pending-queue HTTP route). Mocking the coordinator here would prove nothing:
 * transport-level mocking is precisely what hid this gap.
 */

const SESSION_ID = 'session-1';
const LOCAL_ID = 'local-1';
const MACHINE_ID = 'machine-1';

const SESSION_SECRET = new Uint8Array(32).fill(7);
const SESSION_CRYPTO_CTX = {
  encryptionKey: SESSION_SECRET,
  encryptionVariant: 'legacy' as const,
};

const CREDENTIALS = {
  token: 'token-1',
  encryption: { type: 'legacy' as const, secret: SESSION_SECRET },
} as unknown as StoredCredentials;

const SOURCE_METADATA: Record<string, unknown> = {
  flavor: 'claude',
  machineId: MACHINE_ID,
  path: '/home/u/project',
};

const TARGET_METADATA: Record<string, unknown> = {
  flavor: 'codex',
  machineId: MACHINE_ID,
  path: '/home/u/project',
};

const mocks = vi.hoisted(() => ({
  sessionMode: 'plain' as 'plain' | 'e2ee',
  cutoverApplied: false,
  rawSessionActive: false,
  resolveSessionTransportContext: vi.fn(),
  decryptOwnerMetadataView: vi.fn(),
  waitForSessionIdle: vi.fn(),
  callSessionProviderInputAdmission: vi.fn(),
  requestSessionStop: vi.fn(),
  applySessionAgentTransitionCutover: vi.fn(),
  requestInactiveSessionResume: vi.fn(),
  findTranscriptEncryptedMessageByLocalIdV2: vi.fn(),
  readAgentCatalogSnapshot: vi.fn(),
  resolveReplaySeedDraft: vi.fn(),
  enqueuePendingQueueV2MessageViaHttp: vi.fn(),
  resolveSessionMessageModel: vi.fn(),
  readStoredCredentials: vi.fn(),
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: mocks.resolveSessionTransportContext,
}));
vi.mock('@/session/services/waitForSessionIdle', () => ({
  waitForSessionIdle: mocks.waitForSessionIdle,
}));
vi.mock('@/daemon/startup/providerInputAdmissionRuntime', () => ({
  callSessionProviderInputAdmission: mocks.callSessionProviderInputAdmission,
}));
vi.mock('@/session/services/requestSessionStop', () => ({
  requestSessionStop: mocks.requestSessionStop,
}));
vi.mock('@/session/services/requestInactiveSessionResume', () => ({
  requestInactiveSessionResume: mocks.requestInactiveSessionResume,
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  applySessionAgentTransitionCutover: mocks.applySessionAgentTransitionCutover,
}));
vi.mock('@/api/session/transcriptMessageLookup', () => ({
  findTranscriptEncryptedMessageByLocalIdV2: mocks.findTranscriptEncryptedMessageByLocalIdV2,
}));
vi.mock('@/agent/catalog/snapshot', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/agent/catalog/snapshot')>(),
  readAgentCatalogSnapshot: mocks.readAgentCatalogSnapshot,
}));
vi.mock('@/session/replay/resolveReplaySeedDraft', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/replay/resolveReplaySeedDraft')>(),
  resolveReplaySeedDraft: mocks.resolveReplaySeedDraft,
}));
vi.mock('@/session/transport/encryption/sessionEncryptionContext', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/encryption/sessionEncryptionContext')>(),
  tryDecryptSessionOwnerMetadataView: mocks.decryptOwnerMetadataView,
}));
vi.mock('@/api/session/pendingQueueV2Transport', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/session/pendingQueueV2Transport')>(),
  enqueuePendingQueueV2MessageViaHttp: mocks.enqueuePendingQueueV2MessageViaHttp,
  readBlockedPendingQueueV2DeliveryByLocalIdFromServer: vi.fn(),
}));
vi.mock('@/session/services/resolveSessionMessageModel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/services/resolveSessionMessageModel')>(),
  resolveSessionMessageModel: mocks.resolveSessionMessageModel,
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: mocks.readStoredCredentials,
}));

import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

import { registerMachineSessionRpcHandlers } from './rpcHandlers.sessions';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcHandlerRegistrar } from '../rpc/types';

function buildRawSession(): Record<string, unknown> {
  const storedMetadata = mocks.cutoverApplied ? TARGET_METADATA : SOURCE_METADATA;
  return {
    id: SESSION_ID,
    machineId: MACHINE_ID,
    seq: 42,
    active: mocks.rawSessionActive,
    archivedAt: null,
    // A layout-0 row whose stored payload is real, so the cutover's sealing
    // path decrypts, projects and re-encodes for real in both modes.
    metadata: mocks.sessionMode === 'plain'
      ? JSON.stringify(storedMetadata)
      : encryptSessionPayload({ ctx: SESSION_CRYPTO_CTX, payload: storedMetadata }),
    metadataVersion: 3,
    metadataLayoutVersion: 0,
    ownerMetadata: null,
    agentState: null,
    agentStateVersion: 1,
    encryptionMode: mocks.sessionMode === 'plain' ? 'plain' : 'e2ee',
  };
}

function buildTransportContext() {
  return mocks.sessionMode === 'plain'
    ? {
        ok: true as const,
        sessionId: SESSION_ID,
        rawSession: buildRawSession(),
        accountEncryptionCurrentness: { mode: 'plain' as const },
        ctx: null,
        mode: 'plain' as const,
      }
    : {
        ok: true as const,
        sessionId: SESSION_ID,
        rawSession: buildRawSession(),
        accountEncryptionCurrentness: { mode: 'e2ee' as const },
        ctx: SESSION_CRYPTO_CTX,
        mode: 'e2ee' as const,
      };
}

/**
 * Records every handler the machine session registrar installs, so the test
 * invokes the exact function production dispatches to.
 */
function createCapturingRegistrar() {
  const handlers = new Map<string, RpcHandler>();
  const registrar = {
    registerHandler: (method: string, handler: RpcHandler) => {
      handlers.set(method, handler);
    },
  };
  return {
    handlers,
    manager: registrar as unknown as RpcHandlerManager & RpcHandlerRegistrar,
  };
}

function buildTransitionRequest() {
  return {
    v: 1,
    sessionId: SESSION_ID,
    expectedCurrentAgentId: 'claude',
    selection: { v: 1, agentId: 'codex' },
    input: { text: 'continue with codex', localId: LOCAL_ID },
  };
}

function registerTransitionHandler(
  machineAdmissionTransport?: (
    request: unknown,
    options?: unknown,
  ) => Promise<SessionInputAdmissionResultV1>,
): RpcHandler {
  const { handlers, manager } = createCapturingRegistrar();
  registerMachineSessionRpcHandlers({
    rpcHandlerManager: manager,
    handlers: {
      spawnSession: vi.fn(),
      stopSession: vi.fn(),
      requestShutdown: vi.fn(),
    } as never,
    deps: {
      currentMachineId: MACHINE_ID,
      sessionServerStart: {
        machineId: MACHINE_ID,
        token: 'token-1',
        readCredentials: async () => CREDENTIALS,
        resolveAccountId: async () => 'account-1',
        resolveInstallationId: () => 'installation-1',
        resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain' }),
        ...(machineAdmissionTransport ? { machineAdmissionTransport } : {}),
      },
    } as never,
  });
  const handler = handlers.get(RPC_METHODS.SESSION_AGENT_TRANSITION);
  if (!handler) throw new Error('session.agentTransition was never registered');
  return handler;
}

describe('registered session.agentTransition machine RPC handler', () => {
  beforeEach(() => {
    mocks.sessionMode = 'plain';
    mocks.rawSessionActive = false;
    mocks.cutoverApplied = false;
    for (const value of Object.values(mocks)) {
      if (typeof value === 'function' && 'mockReset' in value) (value as ReturnType<typeof vi.fn>).mockReset();
    }
    mocks.readStoredCredentials.mockResolvedValue(CREDENTIALS);
    mocks.resolveSessionTransportContext.mockImplementation(async () => buildTransportContext());
    // The Session's current Agent is the SOURCE until the cutover commits and
    // the TARGET afterwards, which is what the coordinator's pre-stop
    // currentness recheck and the post-cutover activation each read.
    mocks.decryptOwnerMetadataView.mockImplementation(
      () => (mocks.cutoverApplied ? TARGET_METADATA : SOURCE_METADATA),
    );
    mocks.waitForSessionIdle.mockResolvedValue({
      ok: true, sessionId: SESSION_ID, idle: true, observedAt: 1,
    });
    mocks.callSessionProviderInputAdmission.mockImplementation(
      async (input: { action: string }) => ({
        status: input.action === 'enforce' ? 'enforced' : 'cleared',
      }),
    );
    mocks.requestSessionStop.mockResolvedValue({ ok: true, sessionId: SESSION_ID, stopped: true });
    mocks.applySessionAgentTransitionCutover.mockImplementation(async () => {
      mocks.cutoverApplied = true;
      return { ok: true, dividerSeq: 77 };
    });
    mocks.requestInactiveSessionResume.mockResolvedValue({ ok: true });
    mocks.findTranscriptEncryptedMessageByLocalIdV2.mockResolvedValue(null);
    mocks.readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([
        ['codex', { id: 'codex', identity: { pluginId: 'codex', localId: 'codex' } }],
        ['claude', { id: 'claude', identity: { pluginId: 'claude', localId: 'claude' } }],
      ]),
      catalogEntriesById: {},
    });
    mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'no_source_dialog' });
    mocks.enqueuePendingQueueV2MessageViaHttp.mockResolvedValue({
      didWrite: true, terminal: false, suppressed: false,
    });
    mocks.resolveSessionMessageModel.mockReturnValue({ modelId: null, selection: null });
  });

  it('admits a plain protected transition input through the Account route with no machine transport', async () => {
    const handler = registerTransitionHandler();

    await expect(handler(buildTransitionRequest())).resolves.toEqual({
      type: 'accepted',
      localId: LOCAL_ID,
    });
    expect(mocks.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledTimes(1);
  });

  it('admits an E2EE protected transition input through the authenticated machine transport', async () => {
    mocks.sessionMode = 'e2ee';
    const machineAdmissionTransport = vi.fn(async () => ({
      status: 'accepted' as const,
      localId: LOCAL_ID,
    }));

    const handler = registerTransitionHandler(machineAdmissionTransport);

    await expect(handler(buildTransitionRequest())).resolves.toEqual({
      type: 'accepted',
      localId: LOCAL_ID,
    });
    expect(machineAdmissionTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        v: 1,
        sessionId: SESSION_ID,
        targetMachineId: MACHINE_ID,
        localId: LOCAL_ID,
        content: expect.objectContaining({ t: 'encrypted' }),
      }),
    );
    expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('leaves an E2EE transition committed-but-unadmitted when the registration withholds the transport', async () => {
    mocks.sessionMode = 'e2ee';

    const handler = registerTransitionHandler();

    await expect(handler(buildTransitionRequest())).resolves.toEqual({
      type: 'partially_applied',
      applied: 'current_view_committed',
      code: 'input_rejected',
      localId: LOCAL_ID,
    });
    expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });
});
