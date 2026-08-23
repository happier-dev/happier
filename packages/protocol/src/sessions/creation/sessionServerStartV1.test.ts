import { describe, expect, it } from 'vitest';

import {
  createAccountScopedCryptoMaterialSnapshotV1,
  sealAccountScopedBlobCiphertext,
} from '../../crypto/accountScopedCipher.js';
import {
  SessionServerStartSpawnDraftV1Schema,
  SessionServerStartIngressRequestV1Schema,
  SessionSpawnNewInputV2Schema,
  type SessionServerStartHandlerV1,
} from './sessionServerStartV1.js';
import {
  SessionServerStartSpawnDraftV1Schema as publicSessionServerStartSpawnDraftV1Schema,
} from './sessionSpawnNewInputV2.js';

const draft = {
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: '/workspace',
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
  },
} as const;

describe('SessionServerStartSpawnDraftV1Schema', () => {
  it('re-exports the exact browser-safe Session spawn draft projection', () => {
    expect(SessionServerStartSpawnDraftV1Schema)
      .toBe(publicSessionServerStartSpawnDraftV1Schema);
  });

  it('inherits the strict canonical Session V2 target and Agent contribution target', () => {
    expect(SessionServerStartSpawnDraftV1Schema.parse(draft)).toEqual(draft);
    expect(SessionServerStartSpawnDraftV1Schema.safeParse({
      ...draft,
      executionTarget: { machineId: 'machine-1' },
    }).success).toBe(false);
    expect(SessionServerStartSpawnDraftV1Schema.safeParse({
      ...draft,
      agentTarget: { kind: 'agent', identity: { localId: 'claude' } },
    }).success).toBe(false);
  });

  it('rejects caller-selected creation identity and initial input', () => {
    expect(SessionServerStartSpawnDraftV1Schema.safeParse({
      ...draft,
      creationKey: 'automation-run:forged',
    }).success).toBe(false);
    expect(SessionServerStartSpawnDraftV1Schema.safeParse({
      ...draft,
      initialMessage: 'forged',
    }).success).toBe(false);
  });

  it('excludes raw launch environment from the browser-safe server-start draft', () => {
    expect(SessionServerStartSpawnDraftV1Schema.safeParse({
      ...draft,
      environmentVariables: { TOKEN: 'must-not-enter-server-metadata' },
    }).success).toBe(false);
  });

  it('defines the canonical start handler over exact V2 input and result', () => {
    const handler: SessionServerStartHandlerV1 = async (input) => {
      SessionSpawnNewInputV2Schema.parse(input);
      return {
        type: 'error',
        code: 'cancelled',
        retryable: false,
      };
    };
    expect(typeof handler).toBe('function');
  });

  it('defines one mode-correct opaque Run-to-exact-machine transport without exposing a Session V2 parser to the server', async () => {
    const contract = await import('./sessionServerStartV1.js') as unknown as Readonly<{
      SESSION_SERVER_START_DAEMON_RPC_METHOD_V1?: string;
      SessionServerStartDispatchRequestV1Schema?: Readonly<{
        safeParse: (value: unknown) => Readonly<{ success: boolean }>;
      }>;
    }>;
    const request = {
      v: 1,
      kind: 'session.serverStart.dispatch',
      target: {
        accountId: 'account-1',
        machineId: 'machine-1',
        machineInstallationId: 'installation-1',
      },
      start: {
        automationId: 'automation-1',
        runId: 'run-1',
        origin: 'event',
        accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
        // The server validates only the bounded envelope framing. The target
        // owns exact Session V2 parsing after it revalidates this handoff.
        requestEnvelope: { t: 'plain', v: { opaqueToServer: true } },
      },
    } as const;

    expect(contract.SESSION_SERVER_START_DAEMON_RPC_METHOD_V1).toBe(
      'daemon.sessions.serverStart.dispatch',
    );
    expect(contract.SessionServerStartDispatchRequestV1Schema?.safeParse(request).success).toBe(true);
    const material = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    });
    const encryptedRequestEnvelope = {
      t: 'encrypted' as const,
      c: sealAccountScopedBlobCiphertext({
        kind: 'automation_session_start_request' as never,
        material: material.material,
        // This is intentionally not a Session V2 input. The server must only
        // carry the purpose-tagged opaque ciphertext to the exact target.
        payload: { opaqueToServer: true },
        randomBytes: (length) => new Uint8Array(length).fill(5),
      }),
    };
    expect(contract.SessionServerStartDispatchRequestV1Schema?.safeParse({
      ...request,
      start: {
        ...request.start,
        accountCurrentness: { mode: 'e2ee', version: 7, contentKeyFingerprint: 'key-1' },
        requestEnvelope: encryptedRequestEnvelope,
      },
    }).success).toBe(true);
    expect(contract.SessionServerStartDispatchRequestV1Schema?.safeParse({
      ...request,
      start: { ...request.start, unexpected: true },
    }).success).toBe(false);
  });

  it('accepts only Run correspondence plus an opaque mode-correct request at the machine ingress', () => {
    const request = {
      v: 1,
      kind: 'session.serverStart.ingress',
      runId: 'run-1',
      attempt: 2,
      requestEnvelope: { t: 'plain', v: { opaqueToServer: true } },
    } as const;
    expect(SessionServerStartIngressRequestV1Schema.parse(request)).toEqual(request);
    expect(SessionServerStartIngressRequestV1Schema.safeParse({
      ...request,
      automationId: 'forged-automation',
    }).success).toBe(false);
    expect(SessionServerStartIngressRequestV1Schema.safeParse({
      ...request,
      target: { machineId: 'forged-machine' },
    }).success).toBe(false);
    expect(SessionServerStartIngressRequestV1Schema.safeParse({
      ...request,
      accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
    }).success).toBe(false);
    const material = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    });
    expect(SessionServerStartIngressRequestV1Schema.safeParse({
      ...request,
      requestEnvelope: {
        t: 'encrypted',
        c: sealAccountScopedBlobCiphertext({
          kind: 'automation_session_start_request' as never,
          material: material.material,
          payload: { opaqueToServer: true },
          randomBytes: (length) => new Uint8Array(length).fill(6),
        }),
      },
    }).success).toBe(true);
  });
});
