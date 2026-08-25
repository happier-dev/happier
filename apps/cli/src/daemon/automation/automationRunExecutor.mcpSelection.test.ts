import {
  AutomationSourceSelectorIdV1Schema,
  createAccountScopedCryptoMaterialSnapshotV1,
  deriveAutomationOccurrenceKeyV1,
  isAutomationSessionStartRequestCiphertextV1,
  openAutomationRunResultStoredEnvelopeV1,
  openAutomationSessionStartRequestEnvelopeV1,
  sealAccountScopedBlobCiphertext,
  serializeAutomationRunExecutionRecipeV1,
} from '@happier-dev/protocol';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import type { ClaimableRunPayload } from './automationRunExecutor';
import { abortAutomationRunForAuthoritativeCancellation } from './automationRunCancellation';

type ExecuteClaimedRun = typeof import('./automationRunExecutor').executeClaimedRun;
type AutomationRunClaimClient = Parameters<ExecuteClaimedRun>[0]['claimClient'];
type AutomationRunSucceed = AutomationRunClaimClient['succeedRun'];
type ExecuteAutomationAction = NonNullable<Parameters<ExecuteClaimedRun>[0]['executeAction']>;
type DispatchSessionServerStart = NonNullable<
  Parameters<ExecuteClaimedRun>[0]['dispatchSessionServerStart']
>;
let executeClaimedRun: ExecuteClaimedRun;

const {
  enqueueAutomationPrompt,
  discardAutomationPromptAfterRunCancellation,
  waitForSessionInputResult,
} = vi.hoisted(() => ({
  enqueueAutomationPrompt: vi.fn(),
  discardAutomationPromptAfterRunCancellation: vi.fn(),
  waitForSessionInputResult: vi.fn(),
}));

vi.mock('./automationPendingQueueClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('./automationPendingQueueClient')>(),
  enqueueAutomationPrompt,
  discardAutomationPromptAfterRunCancellation,
}));

vi.mock('@/session/services/sendSessionMessage', () => ({
  waitForSessionInputResult,
}));

const CLAIM_CURRENTNESS = {
  mode: 'plain' as const,
  version: 41,
  contentKeyFingerprint: null,
};

const START_CURRENTNESS = {
  mode: 'plain' as const,
  version: 42,
  contentKeyFingerprint: null,
};

function availableCurrentness(witness: typeof CLAIM_CURRENTNESS | typeof START_CURRENTNESS) {
  return { kind: 'available' as const, witness };
}

function buildStrictClaimedRun(params: {
  recipe: unknown;
  runId?: string;
  origin?: unknown;
  accountCurrentness?: unknown;
  resultDelivery?: unknown;
}): ClaimableRunPayload {
  const serialized = serializeAutomationRunExecutionRecipeV1(params.recipe);
  if (serialized.kind !== 'available') {
    throw new Error('Strict Automation recipe fixture must serialize');
  }
  return {
    protocol: 'v3',
    run: {
      id: params.runId ?? 'run-strict',
      automationId: 'automation-1',
      attempt: 1,
      executionInputEnvelope: serialized.serialized,
      origin: params.origin ?? { kind: 'manual', invokedAt: 1_723_247_201_000 },
      resultDelivery: params.resultDelivery ?? { kind: 'none' },
    },
    automation: {
      id: 'automation-1',
      name: 'Strict recipe',
      enabled: true,
    },
    accountCurrentness: params.accountCurrentness ?? CLAIM_CURRENTNESS,
  } as ClaimableRunPayload;
}

function strictExistingSessionRecipe(params: {
  template?: unknown;
  templateEnvelope?: unknown;
  triggerEvidence?: unknown;
} = {}) {
  return {
    v: 1,
    templateVersion: 1,
    template: params.templateEnvelope ?? {
      t: 'plain' as const,
      v: params.template ?? { v: 1, prompt: 'process the strict task' },
    },
    triggerEvidence: params.triggerEvidence ?? null,
    target: {
      kind: 'existingSession' as const,
      sessionId: 'session-existing',
    },
  };
}

function strictNewSessionRecipe(params: {
  prompt?: string;
  machineId?: string;
  templateEnvelope?: unknown;
} = {}) {
  const machineId = params.machineId ?? 'machine-1';
  return {
    v: 1,
    templateVersion: 1,
    template: params.templateEnvelope ?? {
      t: 'plain' as const,
      v: { v: 1, prompt: params.prompt ?? 'create the strict Session' },
    },
    triggerEvidence: null,
    target: {
      kind: 'newSession' as const,
      spawn: {
        executionTarget: { serverId: 'server-1', machineId },
        directory: '/tmp/strict-new-session',
        agentTarget: {
          kind: 'agent' as const,
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
    },
  };
}

const executionRunEventEvidence = {
  v: 1,
  kind: 'pluginEvent',
  eventRef: { pluginId: 'com.example.execution', localId: 'run-requested' },
  sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
    '00000000-0000-4000-8000-000000000001',
  ),
  occurrenceId: 'occurrence-1',
  occurredAt: 1_723_247_201_000,
  payload: { task: 'detached' },
  sourceInstanceId: 'source-instance-1',
  sourceContractVersion: 1,
  observationReceivedAt: 1_723_247_201_001,
  filter: { version: 1, result: 'matched' },
} as const;

const finalResultConversationEvidence = {
  v: 1,
  kind: 'conversation' as const,
  bindingId: 'binding-1',
  occurrenceId: 'conversation-occurrence-strict',
  occurredAt: 1_723_247_201_000,
  caller: {
    pluginId: 'happier.channels',
    contributionLocalId: 'provider/observation-ingest-v1',
    machineId: 'machine-1',
  },
  input: { message: 'final-result trigger' },
  replyContextIdentity: 'reply-context-strict',
  observationReceivedAt: 1_723_247_201_001,
} as const;

const finalResultConversationOrigin = {
  kind: 'conversation' as const,
  occurrenceKey: deriveAutomationOccurrenceKeyV1({
    v: finalResultConversationEvidence.v,
    kind: finalResultConversationEvidence.kind,
    bindingId: finalResultConversationEvidence.bindingId,
    occurrenceId: finalResultConversationEvidence.occurrenceId,
    occurredAt: finalResultConversationEvidence.occurredAt,
    caller: finalResultConversationEvidence.caller,
    input: finalResultConversationEvidence.input,
    replyContextIdentity: finalResultConversationEvidence.replyContextIdentity,
  }),
  occurredAt: finalResultConversationEvidence.occurredAt,
};

function strictExecutionRunRecipe(params: { triggerEvidence?: typeof executionRunEventEvidence } = {}) {
  return {
    v: 1,
    templateVersion: 1,
    template: {
      t: 'plain' as const,
      v: { v: 1, prompt: 'perform the detached Automation task' },
    },
    triggerEvidence: params.triggerEvidence
      ? { t: 'plain' as const, v: params.triggerEvidence }
      : null,
    target: {
      kind: 'executionRun' as const,
      request: {
        intent: 'task' as const,
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
        permissionMode: 'read_only' as const,
        retentionPolicy: 'ephemeral' as const,
        runClass: 'bounded' as const,
        ioMode: 'request_response' as const,
      },
    },
  };
}

function buildClaimedRun(overrides: {
  run?: Partial<ClaimableRunPayload['run']>;
  automation?: Partial<ClaimableRunPayload['automation']>;
} = {}): ClaimableRunPayload {
  return {
    protocol: 'v2',
    run: {
      id: 'run-1',
      automationId: 'automation-1',
      attempt: 1,
      ...overrides.run,
    },
    automation: {
      id: 'automation-1',
      name: 'Nightly',
      enabled: true,
      targetType: 'new_session',
      templateCiphertext: JSON.stringify({
        kind: 'happier_automation_template_plain_v1',
        payload: { directory: '/tmp/project' },
      }),
      ...overrides.automation,
    },
  };
}

describe('executeClaimedRun (mcpSelection)', () => {
  beforeAll(async () => {
    ({ executeClaimedRun } = await import('./automationRunExecutor'));
  });

  beforeEach(() => {
    enqueueAutomationPrompt.mockReset();
    enqueueAutomationPrompt.mockResolvedValue({ status: 'accepted', localId: 'automation:run-strict' });
    discardAutomationPromptAfterRunCancellation.mockReset();
    discardAutomationPromptAfterRunCancellation.mockResolvedValue(undefined);
    waitForSessionInputResult.mockReset();
  });

  it('materializes a strict existing-session Run under C, starts with C, then invokes the canonical input owner only under S', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const resolveAutomationAccountEncryption = vi.fn()
      .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
      .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      machineAdmissionTransport: vi.fn(async () => ({
        status: 'accepted' as const,
        localId: 'automation:run-strict',
      })),
      resolveAutomationAccountEncryption,
      claimed: buildStrictClaimedRun({ recipe: strictExistingSessionRecipe() }),
    });

    expect(claimClient.startRun).toHaveBeenCalledWith({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: CLAIM_CURRENTNESS,
    });
    expect(enqueueAutomationPrompt).toHaveBeenCalledWith(expect.objectContaining({
      automationId: 'automation-1',
      runId: 'run-strict',
      sessionId: 'session-existing',
      prompt: 'process the strict task',
    }));
    expect(spawnSession).not.toHaveBeenCalled();
    expect(claimClient.succeedRun).toHaveBeenCalledWith({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: 'session-existing',
    });
    expect(claimClient.failRun).not.toHaveBeenCalled();
    expect(resolveAutomationAccountEncryption).toHaveBeenCalledTimes(2);
  });

  it('waits for the exact accepted existing-Session turn and seals its final text once', async () => {
    waitForSessionInputResult.mockResolvedValue({
      ok: true,
      sessionId: 'session-existing',
      localId: 'automation:run-strict',
      result: { kind: 'final_text', text: 'final text from the exact turn' },
    });
    const succeedRun = vi.fn<AutomationRunSucceed>(async () => {});
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun,
      failRun: vi.fn(async () => {}),
    };
    const credentials = { token: 'token', encryption: null };

    await executeClaimedRun({
      token: 'token',
      credentials,
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'must-not-spawn',
      })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      machineAdmissionTransport: vi.fn(async () => ({
        status: 'accepted' as const,
        localId: 'automation:run-strict',
      })),
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({
        recipe: strictExistingSessionRecipe({
          triggerEvidence: { t: 'plain', v: finalResultConversationEvidence },
        }),
        origin: finalResultConversationOrigin,
        resultDelivery: {
          kind: 'finalResult',
          accountId: 'account-1',
          handoffId: 'automation-reply-handoff:run-strict',
        },
      }),
    });

    expect(claimClient.startRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-strict',
      accountCurrentness: CLAIM_CURRENTNESS,
    }));
    expect(enqueueAutomationPrompt).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-strict',
      sessionId: 'session-existing',
    }));
    expect(claimClient.failRun).not.toHaveBeenCalled();
    expect(waitForSessionInputResult).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'session-existing',
      localId: 'automation:run-strict',
      timeoutMs: 120_000,
      maxResultTextUtf8Bytes: 256 * 1024,
    });
    expect(succeedRun).toHaveBeenCalledOnce();
    const succeedCall = succeedRun.mock.calls[0]?.[0];
    expect(succeedCall).toEqual(expect.objectContaining({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: 'session-existing',
      resultEnvelope: expect.any(String),
    }));
    if (!succeedCall || !('resultEnvelope' in succeedCall) || typeof succeedCall.resultEnvelope !== 'string') {
      throw new Error('Expected final-result settlement to carry a stored envelope');
    }
    const storedEnvelope = JSON.parse(succeedCall.resultEnvelope);
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'plain',
      envelope: storedEnvelope,
    })).toEqual({
      kind: 'available',
      correspondence: {
        accountId: 'account-1',
        automationId: 'automation-1',
        runId: 'run-strict',
        handoffId: 'automation-reply-handoff:run-strict',
      },
      result: { v: 1, kind: 'text', text: 'final text from the exact turn' },
    });
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('seals an exact existing-Session final result with the current E2EE material', async () => {
    const accountEncryption = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(33) },
    });
    const claimCurrentness = {
      mode: 'e2ee' as const,
      version: 81,
      contentKeyFingerprint: 'content-key-81',
    };
    const startCurrentness = {
      ...claimCurrentness,
      version: 82,
    };
    const encryptedTemplate = sealAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: accountEncryption.material,
      payload: { v: 1, prompt: 'process the strict task' },
      randomBytes: (length) => new Uint8Array(length).fill(34),
    });
    const encryptedTriggerEvidence = sealAccountScopedBlobCiphertext({
      kind: 'automation_trigger_evidence',
      material: accountEncryption.material,
      payload: finalResultConversationEvidence,
      randomBytes: (length) => new Uint8Array(length).fill(35),
    });
    waitForSessionInputResult.mockResolvedValue({
      ok: true,
      sessionId: 'session-existing',
      localId: 'automation:run-strict',
      result: { kind: 'final_text', text: 'encrypted final text from the exact turn' },
    });
    const succeedRun = vi.fn<AutomationRunSucceed>(async () => {});
    const claimClient = {
      startRun: vi.fn(async () => startCurrentness),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun,
      failRun: vi.fn(async () => {}),
    };
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(33) },
    };

    await executeClaimedRun({
      token: 'token',
      credentials,
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'must-not-spawn',
      })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      machineAdmissionTransport: vi.fn(async () => ({
        status: 'accepted' as const,
        localId: 'automation:run-strict',
      })),
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce({
          kind: 'available' as const,
          witness: claimCurrentness,
          material: accountEncryption,
        })
        .mockResolvedValueOnce({
          kind: 'available' as const,
          witness: startCurrentness,
          material: accountEncryption,
        }),
      claimed: buildStrictClaimedRun({
        accountCurrentness: claimCurrentness,
        recipe: strictExistingSessionRecipe({
          templateEnvelope: { t: 'encrypted', c: encryptedTemplate },
          triggerEvidence: { t: 'encrypted', c: encryptedTriggerEvidence },
        }),
        origin: finalResultConversationOrigin,
        resultDelivery: {
          kind: 'finalResult',
          accountId: 'account-1',
          handoffId: 'automation-reply-handoff:run-strict',
        },
      }),
    });

    expect(claimClient.failRun).not.toHaveBeenCalled();
    expect(succeedRun).toHaveBeenCalledOnce();
    const succeedCall = succeedRun.mock.calls[0]?.[0];
    if (!succeedCall || !('resultEnvelope' in succeedCall) || typeof succeedCall.resultEnvelope !== 'string') {
      throw new Error('Expected final-result settlement to carry a stored envelope');
    }
    const storedEnvelope = JSON.parse(succeedCall.resultEnvelope);
    expect(storedEnvelope).toMatchObject({ t: 'encrypted' });
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'e2ee',
      envelope: storedEnvelope,
      material: accountEncryption.material,
    })).toEqual({
      kind: 'available',
      correspondence: {
        accountId: 'account-1',
        automationId: 'automation-1',
        runId: 'run-strict',
        handoffId: 'automation-reply-handoff:run-strict',
      },
      result: { v: 1, kind: 'text', text: 'encrypted final text from the exact turn' },
    });
  });

  it('does not start a strict existing-session Run when C is no longer current', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      machineAdmissionTransport: vi.fn(async () => ({
        status: 'accepted' as const,
        localId: 'automation:run-strict',
      })),
      resolveAutomationAccountEncryption: vi.fn(async () => availableCurrentness({
        ...CLAIM_CURRENTNESS,
        version: CLAIM_CURRENTNESS.version + 1,
      })),
      claimed: buildStrictClaimedRun({ recipe: strictExistingSessionRecipe() }),
    });

    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(enqueueAutomationPrompt).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('does not invoke or settle a strict existing-session target when S is no longer current', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const resolveAutomationAccountEncryption = vi.fn()
      .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
      .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      machineAdmissionTransport: vi.fn(async () => ({
        status: 'accepted' as const,
        localId: 'automation:run-strict',
      })),
      resolveAutomationAccountEncryption,
      claimed: buildStrictClaimedRun({ recipe: strictExistingSessionRecipe() }),
    });

    expect(claimClient.startRun).toHaveBeenCalledWith(expect.objectContaining({
      accountCurrentness: CLAIM_CURRENTNESS,
    }));
    expect(enqueueAutomationPrompt).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('terminalizes a malformed strict recipe under C without starting or invoking a target owner', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };
    const claimed = {
      ...buildStrictClaimedRun({ recipe: strictExistingSessionRecipe() }),
      run: {
        ...buildStrictClaimedRun({ recipe: strictExistingSessionRecipe() }).run,
        executionInputEnvelope: '{"v":1}',
      },
    } as ClaimableRunPayload;

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      resolveAutomationAccountEncryption: vi.fn(async () => availableCurrentness(CLAIM_CURRENTNESS)),
      claimed,
    });

    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(enqueueAutomationPrompt).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(claimClient.failRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: CLAIM_CURRENTNESS,
      errorCode: 'invalid_template',
    }));
  });

  it('terminalizes decrypted-invalid strict content under C without starting or invoking a target owner', async () => {
    const material = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    });
    const accountCurrentness = {
      mode: 'e2ee' as const,
      version: 61,
      contentKeyFingerprint: 'current-key',
    };
    const invalidTemplateCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: material.material,
      payload: { v: 99, prompt: 'not a strict template' },
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      resolveAutomationAccountEncryption: vi.fn(async () => ({
        kind: 'available' as const,
        witness: accountCurrentness,
        material,
      })),
      claimed: buildStrictClaimedRun({
        recipe: strictExistingSessionRecipe({
          templateEnvelope: { t: 'encrypted', c: invalidTemplateCiphertext },
        }),
        accountCurrentness,
      }),
    });

    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(enqueueAutomationPrompt).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(claimClient.failRun).toHaveBeenCalledWith(expect.objectContaining({
      accountCurrentness,
      errorCode: 'invalid_template',
    }));
  });

  it('starts a strict plain new-Session Run through the one Session-owned dispatcher with the effect-derived key and message', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const dispatchSessionServerStart = vi.fn(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-created',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted' as const, localId: 'automation:run:run-strict' },
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };
    const execution = {
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
    };

    await executeClaimedRun(execution);

    expect(claimClient.startRun).toHaveBeenCalledWith({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: CLAIM_CURRENTNESS,
    });
    expect(dispatchSessionServerStart).toHaveBeenCalledWith(expect.objectContaining({
      v: 1,
      kind: 'session.serverStart.ingress',
      runId: 'run-strict',
      attempt: 1,
      requestEnvelope: {
        t: 'plain',
        v: expect.objectContaining({
          creationKey: 'automation-run:run-strict',
          initialMessage: 'create the strict Session',
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        }),
      },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(spawnSession).not.toHaveBeenCalled();
    expect(enqueueAutomationPrompt).not.toHaveBeenCalled();
    expect(claimClient.succeedRun).toHaveBeenCalledWith({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: 'session-created',
    });
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('seals a strict E2EE new-Session Run with byte 21 only after S currentness and dispatches no plaintext V2 bytes', async () => {
    const accountEncryption = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(27) },
    });
    const claimCurrentness = {
      mode: 'e2ee' as const,
      version: 71,
      contentKeyFingerprint: 'content-key-71',
    };
    const startCurrentness = {
      ...claimCurrentness,
      version: 72,
    };
    const dispatchSessionServerStart = vi.fn<DispatchSessionServerStart>(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-created-e2ee',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted' as const, localId: 'automation:run:run-strict' },
    }));
    const claimClient = {
      startRun: vi.fn(async () => startCurrentness),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };
    const encryptedTemplate = sealAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: accountEncryption.material,
      payload: { v: 1, prompt: 'create the strict Session' },
      randomBytes: (length) => new Uint8Array(length).fill(28),
    });

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'must-not-spawn',
      })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce({
          kind: 'available' as const,
          witness: claimCurrentness,
          material: accountEncryption,
        })
        .mockResolvedValueOnce({
          kind: 'available' as const,
          witness: startCurrentness,
          material: accountEncryption,
        }),
      claimed: buildStrictClaimedRun({
        accountCurrentness: claimCurrentness,
        recipe: strictNewSessionRecipe({
          templateEnvelope: { t: 'encrypted', c: encryptedTemplate },
        }),
      }),
    });

    expect(dispatchSessionServerStart).toHaveBeenCalledOnce();
    const request = dispatchSessionServerStart.mock.calls[0]?.[0];
    expect(request).toEqual(expect.objectContaining({
      runId: 'run-strict',
      attempt: 1,
      requestEnvelope: expect.objectContaining({ t: 'encrypted' }),
    }));
    const envelope = request?.requestEnvelope;
    expect(envelope?.t).toBe('encrypted');
    if (envelope?.t !== 'encrypted') throw new Error('expected E2EE request envelope');
    expect(isAutomationSessionStartRequestCiphertextV1(envelope.c)).toBe(true);
    expect(openAutomationSessionStartRequestEnvelopeV1({
      mode: 'e2ee',
      envelope,
      material: accountEncryption.material,
    })).toEqual(expect.objectContaining({
      kind: 'available',
      input: expect.objectContaining({
        creationKey: 'automation-run:run-strict',
        initialMessage: 'create the strict Session',
      }),
    }));
    expect(claimClient.succeedRun).toHaveBeenCalledWith(expect.objectContaining({
      accountCurrentness: startCurrentness,
      producedSessionId: 'session-created-e2ee',
    }));
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('routes a strict plain cross-machine new-Session Run only through the Session-owned ingress', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const dispatchSessionServerStart = vi.fn(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-on-machine-2',
      executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted' as const, localId: 'automation:run:run-strict' },
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    const execution = {
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe({ machineId: 'machine-2' }) }),
    };

    await executeClaimedRun(execution);

    expect(claimClient.startRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-strict',
      machineId: 'machine-1',
      accountCurrentness: CLAIM_CURRENTNESS,
    }));
    expect(dispatchSessionServerStart).toHaveBeenCalledWith(expect.objectContaining({
      v: 1,
      kind: 'session.serverStart.ingress',
      runId: 'run-strict',
      attempt: 1,
      requestEnvelope: { t: 'plain', v: expect.objectContaining({
        creationKey: 'automation-run:run-strict',
        initialMessage: 'create the strict Session',
        executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
      }) },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(spawnSession).not.toHaveBeenCalled();
    expect(claimClient.succeedRun).toHaveBeenCalledWith(expect.objectContaining({
      producedSessionId: 'session-on-machine-2',
      accountCurrentness: START_CURRENTNESS,
    }));
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('terminalizes a nonretryable Session-start error under S but leaves a retryable error leased', async () => {
    const executeWithResult = async (result: Awaited<ReturnType<DispatchSessionServerStart>>) => {
      const claimClient = {
        startRun: vi.fn(async () => START_CURRENTNESS),
        heartbeatRun: vi.fn(async () => {}),
        succeedRun: vi.fn(async () => {}),
        failRun: vi.fn(async () => {}),
      };
      await executeClaimedRun({
        token: 'token',
        credentials: { token: 'token', encryption: null },
        machineId: 'machine-1',
        claimClient,
        spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
          type: 'success',
          sessionId: 'must-not-spawn',
        })),
        heartbeatMs: 60_000,
        leaseDurationMs: 120_000,
        dispatchSessionServerStart: vi.fn<DispatchSessionServerStart>(async () => result),
        resolveAutomationAccountEncryption: vi.fn()
          .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
          .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
        claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
      });
      return claimClient;
    };

    const nonretryable = await executeWithResult({
      type: 'error',
      code: 'incompatible_target',
      retryable: false,
    });

    expect(nonretryable.failRun).toHaveBeenCalledOnce();
    expect(nonretryable.failRun).toHaveBeenCalledWith({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      errorCode: 'incompatible_target',
      errorDetailEnvelope: JSON.stringify({
        t: 'plain',
        v: {
          v: 1,
          correspondence: {
            automationId: 'automation-1',
            runId: 'run-strict',
          },
          detail: 'Automation Session start failed: incompatible_target',
        },
      }),
    });
    expect(nonretryable.succeedRun).not.toHaveBeenCalled();

    const retryable = await executeWithResult({
      type: 'error',
      code: 'target_unavailable',
      retryable: true,
    });

    expect(retryable.failRun).not.toHaveBeenCalled();
    expect(retryable.succeedRun).not.toHaveBeenCalled();
  });

  it('keeps a strict new-Session Run retryable after a Session-start response loss and settles only when the rejoin proves admission', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const dispatchSessionServerStart = vi.fn()
      .mockResolvedValueOnce({
        type: 'pending' as const,
        retryWithSameCreationKey: true as const,
        outcome: 'unknown' as const,
      })
      .mockResolvedValueOnce({
        type: 'success' as const,
        disposition: 'rejoined' as const,
        sessionId: 'session-rejoined',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'alreadyAccepted' as const, localId: 'automation:run:run-strict' },
      });
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };
    const first = {
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
    };

    await executeClaimedRun(first);

    expect(dispatchSessionServerStart).toHaveBeenCalledTimes(1);
    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();

    await executeClaimedRun({
      ...first,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
    });

    expect(dispatchSessionServerStart).toHaveBeenCalledTimes(2);
    expect(dispatchSessionServerStart.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      requestEnvelope: { t: 'plain', v: expect.objectContaining({
        creationKey: 'automation-run:run-strict',
        initialMessage: 'create the strict Session',
      }) },
    }));
    expect(claimClient.succeedRun).toHaveBeenCalledWith(expect.objectContaining({
      producedSessionId: 'session-rejoined',
      accountCurrentness: START_CURRENTNESS,
    }));
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('records a known Session when its required initial input outcome is unknown', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const dispatchSessionServerStart = vi.fn(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-created',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: {
        status: 'outcomeUnknown' as const,
        localId: 'automation:run:run-strict',
        code: 'response_lost',
      },
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    const execution = {
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
    };

    await executeClaimedRun(execution);

    expect(dispatchSessionServerStart).toHaveBeenCalledOnce();
    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).toHaveBeenCalledWith(expect.objectContaining({
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: 'session-created',
      errorCode: 'prompt_delivery_outcome_unknown',
    }));
  });

  it('records the Run input failure without reclassifying a created strict new Session as a creation failure', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const dispatchSessionServerStart = vi.fn(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-created',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'rejected' as const, code: 'session_input_invalid' as const },
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    const execution = {
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
    };

    await executeClaimedRun(execution);

    expect(dispatchSessionServerStart).toHaveBeenCalledOnce();
    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).toHaveBeenCalledWith(expect.objectContaining({
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: 'session-created',
      errorCode: 'prompt_delivery_failed',
    }));
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not settle a strict new-Session Run from a canonical result for a different execution target', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const dispatchSessionServerStart = vi.fn(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-on-wrong-machine',
      executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted' as const, localId: 'automation:run:run-strict' },
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    const execution = {
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
    };

    await executeClaimedRun(execution);

    expect(claimClient.startRun).toHaveBeenCalledWith(expect.objectContaining({
      accountCurrentness: CLAIM_CURRENTNESS,
    }));
    expect(dispatchSessionServerStart).toHaveBeenCalledOnce();
    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not invoke a strict new-Session target when S is no longer current', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const dispatchSessionServerStart = vi.fn(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'must-not-dispatch',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted' as const, localId: 'automation:run:run-strict' },
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    const execution = {
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness({
          ...START_CURRENTNESS,
          version: START_CURRENTNESS.version + 1,
      })),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
    };

    await executeClaimedRun(execution);

    expect(claimClient.startRun).toHaveBeenCalledWith(expect.objectContaining({
      accountCurrentness: CLAIM_CURRENTNESS,
    }));
    expect(dispatchSessionServerStart).not.toHaveBeenCalled();
    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('preserves a known Session through the incumbent cancellation settlement when cancellation wins after dispatch begins', async () => {
    const cancellation = new AbortController();
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const dispatchSessionServerStart = vi.fn(async (
      _request: unknown,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => {
      expect(options?.signal?.aborted).toBe(false);
      abortAutomationRunForAuthoritativeCancellation(cancellation);
      return {
        type: 'success' as const,
        disposition: 'created' as const,
        sessionId: 'session-created',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'accepted' as const, localId: 'automation:run:run-strict' },
      };
    });
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    const execution = {
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: cancellation.signal,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
    };

    await executeClaimedRun(execution);

    expect(dispatchSessionServerStart).toHaveBeenCalledOnce();
    expect(dispatchSessionServerStart.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).toHaveBeenCalledWith(expect.objectContaining({
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: 'session-created',
      errorCode: 'session_start_cancelled_after_create',
    }));
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'accepted first input',
      initialInput: { status: 'accepted' as const, localId: 'automation:run:run-strict-settlement-fallback' },
      disposition: 'created' as const,
      firstSettlement: 'succeed' as const,
      firstErrorCode: null,
    },
    {
      name: 'already-accepted first input',
      initialInput: { status: 'alreadyAccepted' as const, localId: 'automation:run:run-strict-settlement-fallback' },
      disposition: 'rejoined' as const,
      firstSettlement: 'succeed' as const,
      firstErrorCode: null,
    },
    {
      name: 'rejected first input',
      initialInput: { status: 'rejected' as const, code: 'session_input_invalid' as const },
      disposition: 'created' as const,
      firstSettlement: 'fail' as const,
      firstErrorCode: 'prompt_delivery_failed' as const,
    },
    {
      name: 'outcome-unknown first input',
      initialInput: {
        status: 'outcomeUnknown' as const,
        localId: 'automation:run:run-strict-settlement-fallback',
        code: 'session_input_outcome_unknown',
      },
      disposition: 'created' as const,
      firstSettlement: 'fail' as const,
      firstErrorCode: 'prompt_delivery_outcome_unknown' as const,
    },
  ])('retains a known strict V3 Session when the first $name settlement request loses its response', async ({
    initialInput,
    disposition,
    firstSettlement,
    firstErrorCode,
  }) => {
    const sessionId = `session-strict-settlement-fallback-${initialInput.status}`;
    const succeedRun = vi.fn(async () => {});
    const failRun = vi.fn(async () => {});
    if (firstSettlement === 'succeed') {
      succeedRun.mockRejectedValueOnce(new Error('succeed transport failed before commit'));
    } else {
      failRun.mockRejectedValueOnce(new Error('fail transport failed before commit'));
    }
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun,
      failRun,
    };
    const dispatchSessionServerStart = vi.fn<DispatchSessionServerStart>(async () => ({
      type: 'success',
      disposition,
      sessionId,
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput,
    }));

    await executeClaimedRun({
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'must-not-spawn',
      })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
    });

    const knownSession = {
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: sessionId,
    };
    expect(dispatchSessionServerStart).toHaveBeenCalledOnce();
    if (firstSettlement === 'succeed') {
      expect(succeedRun).toHaveBeenCalledWith(knownSession);
      expect(failRun).toHaveBeenCalledWith(expect.objectContaining({
        ...knownSession,
        errorCode: 'unexpected_error',
      }));
      return;
    }

    expect(succeedRun).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenNthCalledWith(1, expect.objectContaining({
      ...knownSession,
      errorCode: firstErrorCode,
    }));
    expect(failRun).toHaveBeenNthCalledWith(2, expect.objectContaining({
      ...knownSession,
      errorCode: 'unexpected_error',
    }));
  });

  it('retains a known strict V3 Session when the first authoritative-cancellation settlement request loses its response', async () => {
    const cancellation = new AbortController();
    const sessionId = 'session-strict-cancellation-settlement-fallback';
    const failRun = vi.fn()
      .mockRejectedValueOnce(new Error('cancellation retention transport failed before commit'))
      .mockResolvedValueOnce(undefined);
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun,
    };
    const dispatchSessionServerStart = vi.fn<DispatchSessionServerStart>(async () => {
      abortAutomationRunForAuthoritativeCancellation(cancellation);
      return {
        type: 'success',
        disposition: 'created',
        sessionId,
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'accepted', localId: 'automation:run:run-strict' },
      };
    });

    await executeClaimedRun({
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'must-not-spawn',
      })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: cancellation.signal,
      dispatchSessionServerStart,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
    });

    expect(failRun).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: sessionId,
      errorCode: 'session_start_cancelled_after_create',
    }));
    expect(dispatchSessionServerStart).toHaveBeenCalledOnce();
    expect(failRun).toHaveBeenNthCalledWith(2, expect.objectContaining({
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: sessionId,
      errorCode: 'unexpected_error',
    }));
  });

  it('does not invent a fallback settlement after ordinary currentness loss following a strict V3 Session result', async () => {
    const invalidation = new AbortController();
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'must-not-spawn',
      })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: invalidation.signal,
      dispatchSessionServerStart: vi.fn<DispatchSessionServerStart>(async () => {
        invalidation.abort();
        return {
          type: 'success',
          disposition: 'created',
          sessionId: 'session-currentness-lost',
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          organizationPlacement: { folderId: null, tagIds: [] },
          initialInput: { status: 'accepted', localId: 'automation:run:run-strict' },
        };
      }),
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictNewSessionRecipe() }),
    });

    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('dispatches a permitted strict execution Run once through the canonical Action executor with one stable Automation identity', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const executeAction = vi.fn(async () => ({
      ok: true as const,
      result: {
        runId: 'native-run-1',
        callId: 'native-call-1',
        sidechainId: 'native-sidechain-1',
        wait: {
          ok: true as const,
          status: 'succeeded' as const,
          result: { run: { runId: 'native-run-1', status: 'succeeded' as const } },
        },
      },
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };

    const execute = () => executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      executeAction,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({
        recipe: strictExecutionRunRecipe({ triggerEvidence: executionRunEventEvidence }),
        runId: 'run-stable-execution',
        origin: {
          kind: 'pluginEvent',
          occurrenceKey: deriveAutomationOccurrenceKeyV1({
            v: executionRunEventEvidence.v,
            kind: executionRunEventEvidence.kind,
            eventRef: executionRunEventEvidence.eventRef,
            sourceSelectorId: executionRunEventEvidence.sourceSelectorId,
            occurrenceId: executionRunEventEvidence.occurrenceId,
            occurredAt: executionRunEventEvidence.occurredAt,
            payload: executionRunEventEvidence.payload,
          }),
          sourceSelectorId: executionRunEventEvidence.sourceSelectorId,
          occurredAt: executionRunEventEvidence.occurredAt,
        },
      }),
    });

    await execute();

    expect(executeAction).toHaveBeenCalledWith(
      'execution.run.start',
      expect.objectContaining({
        sessionId: null,
        waitForCompletion: true,
        instructions: expect.stringContaining('perform the detached Automation task'),
      }),
      expect.objectContaining({
        actionRequestId: 'automation-run:run-stable-execution',
        executionRunTargetMachineId: 'machine-1',
        signal: expect.any(AbortSignal),
        actionCaller: {
          kind: 'automationRun',
          runId: 'run-stable-execution',
          automationId: 'automation-1',
          origin: 'event',
        },
      }),
    );
    expect(claimClient.settleExecutionDispatch).toHaveBeenCalledWith({
      runId: 'run-stable-execution',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      outcome: {
        kind: 'started',
        runId: 'native-run-1',
        callId: 'native-call-1',
        sidechainId: 'native-sidechain-1',
        wait: {
          ok: true,
          status: 'succeeded',
          result: { run: { runId: 'native-run-1', status: 'succeeded' } },
        },
      },
    });
    expect(enqueueAutomationPrompt).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('rejects final-result delivery for a strict execution-Run target before native execution starts', async () => {
    const executeAction = vi.fn<ExecuteAutomationAction>();
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'must-not-spawn',
      })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      executeAction,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS)),
      claimed: buildStrictClaimedRun({
        recipe: {
          ...strictExecutionRunRecipe(),
          triggerEvidence: { t: 'plain', v: finalResultConversationEvidence },
        },
        origin: finalResultConversationOrigin,
        resultDelivery: {
          kind: 'finalResult',
          accountId: 'account-1',
          handoffId: 'automation-reply-handoff:run-strict',
        },
      }),
    });

    expect(executeAction).not.toHaveBeenCalled();
    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(claimClient.settleExecutionDispatch).not.toHaveBeenCalled();
    expect(claimClient.succeedRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-strict',
      accountCurrentness: CLAIM_CURRENTNESS,
      errorCode: 'execution_run_final_result_unsupported',
      errorDetailEnvelope: expect.any(String),
    }));
  });

  it('commits only strict noRunCreated evidence as a bounded fresh-attempt candidate', async () => {
    const executeAction = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'execution_run_target_unavailable',
      error: 'execution_run_target_unavailable',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' as const } },
    }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      executeAction,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(executeAction).toHaveBeenCalledOnce();
    expect(claimClient.settleExecutionDispatch).toHaveBeenCalledWith({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      outcome: {
        kind: 'noRunCreated',
        errorCode: 'execution_run_target_unavailable',
      },
    });
  });

  it.each([
    ['missing classification', {
      ok: false as const,
      errorCode: 'execution_run_target_unavailable',
      error: 'execution_run_target_unavailable',
    }],
    ['malformed classification', {
      ok: false as const,
      errorCode: 'execution_run_target_unavailable',
      error: 'execution_run_target_unavailable',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated', retryable: true } },
    }],
    ['explicit outcomeUnknown', {
      ok: false as const,
      errorCode: 'execution_run_target_unavailable',
      error: 'execution_run_target_unavailable',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' as const } },
    }],
  ])('commits %s as outcomeUnknown and never treats it as fresh-attempt permission', async (_name, actionResult) => {
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      executeAction: vi.fn(async () => actionResult),
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(claimClient.settleExecutionDispatch).toHaveBeenCalledWith({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      outcome: {
        kind: 'outcomeUnknown',
        errorCode: 'execution_run_target_unavailable',
      },
    });
  });

  it('commits a thrown Action response-loss failure as outcomeUnknown', async () => {
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      executeAction: vi.fn(async () => {
        throw new Error('response lost after Action dispatch');
      }),
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(claimClient.settleExecutionDispatch).toHaveBeenCalledWith({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      outcome: {
        kind: 'outcomeUnknown',
        errorCode: 'execution_run_target_unavailable',
      },
    });
  });

  it('does not create or stop an execution Run after authoritative cancellation before start', async () => {
    const cancellation = new AbortController();
    abortAutomationRunForAuthoritativeCancellation(cancellation);
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };
    const executeAction = vi.fn(async () => ({ ok: true as const, result: { ok: true as const } }));

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: cancellation.signal,
      executeAction,
      resolveAutomationAccountEncryption: vi.fn(),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
    expect(claimClient.settleExecutionDispatch).not.toHaveBeenCalled();
  });

  it('stops a known native execution Run when authoritative Automation cancellation wins after start', async () => {
    const cancellation = new AbortController();
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };
    const executeAction = vi.fn<ExecuteAutomationAction>(async (actionId) => {
      if (actionId === 'execution.run.start') {
        abortAutomationRunForAuthoritativeCancellation(cancellation);
        return {
          ok: true as const,
          result: {
            runId: 'native-run-after-authoritative-cancel',
            callId: 'native-call-after-authoritative-cancel',
            sidechainId: 'native-sidechain-after-authoritative-cancel',
            wait: { ok: false as const, code: 'cancelled' as const },
          },
        };
      }
      return { ok: true as const, result: { ok: true as const } };
    });

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: cancellation.signal,
      executeAction,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(executeAction).toHaveBeenNthCalledWith(
      1,
      'execution.run.start',
      expect.objectContaining({ sessionId: null, waitForCompletion: true }),
      expect.objectContaining({
        actionRequestId: 'automation-run:run-strict',
        executionRunTargetMachineId: 'machine-1',
        actionCaller: expect.objectContaining({ kind: 'automationRun', runId: 'run-strict' }),
      }),
    );
    expect(executeAction).toHaveBeenNthCalledWith(
      2,
      'execution.run.stop',
      { sessionId: null, runId: 'native-run-after-authoritative-cancel' },
      expect.objectContaining({
        actionRequestId: 'automation-run:run-strict:stop',
        executionRunTargetMachineId: 'machine-1',
        actionCaller: expect.objectContaining({ kind: 'automationRun', runId: 'run-strict' }),
      }),
    );
    const stopContext = executeAction.mock.calls[1]?.[2];
    expect(stopContext?.signal).not.toBe(cancellation.signal);
    expect(stopContext?.signal.aborted).toBe(false);
    // The stop is best effort and unconfirmed, so the identity the start
    // returned is reported to the one dispatch settlement owner. Cancellation
    // still owns the Run terminality; only the pointer is retained.
    expect(claimClient.settleExecutionDispatch).toHaveBeenCalledWith({
      runId: 'run-strict',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      outcome: {
        kind: 'started',
        runId: 'native-run-after-authoritative-cancel',
        callId: 'native-call-after-authoritative-cancel',
        sidechainId: 'native-sidechain-after-authoritative-cancel',
        wait: { ok: false, code: 'cancelled' },
      },
    });
  });

  it('does not infer a native Run from strict noRunCreated evidence after authoritative cancellation', async () => {
    const cancellation = new AbortController();
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };
    const executeAction = vi.fn(async () => {
      abortAutomationRunForAuthoritativeCancellation(cancellation);
      return {
        ok: false as const,
        errorCode: 'execution_run_target_unavailable',
        error: 'execution_run_target_unavailable',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' as const } },
      };
    });

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: cancellation.signal,
      executeAction,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(executeAction).toHaveBeenCalledOnce();
    expect(executeAction).toHaveBeenCalledWith(
      'execution.run.start',
      expect.anything(),
      expect.anything(),
    );
    expect(claimClient.settleExecutionDispatch).not.toHaveBeenCalled();
  });

  it('stops a known native execution Run when authoritative cancellation arrives during dispatch settlement', async () => {
    const cancellation = new AbortController();
    const settleExecutionDispatch = vi.fn(async () => {
      abortAutomationRunForAuthoritativeCancellation(cancellation);
    });
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch,
    };
    const executeAction = vi.fn(async (actionId: string) => actionId === 'execution.run.start'
      ? {
          ok: true as const,
          result: {
            runId: 'native-run-cancelled-during-settlement',
            callId: 'native-call-cancelled-during-settlement',
            sidechainId: 'native-sidechain-cancelled-during-settlement',
            wait: { ok: false as const, code: 'timeout' as const },
          },
        }
      : { ok: true as const, result: { ok: true as const } });

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: cancellation.signal,
      executeAction,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(settleExecutionDispatch).toHaveBeenCalledOnce();
    expect(executeAction).toHaveBeenNthCalledWith(
      2,
      'execution.run.stop',
      { sessionId: null, runId: 'native-run-cancelled-during-settlement' },
      expect.objectContaining({ actionRequestId: 'automation-run:run-strict:stop' }),
    );
  });

  it('does not claim a native stop when cancellation follows an ambiguous execution Run start', async () => {
    const cancellation = new AbortController();
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };
    const executeAction = vi.fn(async () => {
      abortAutomationRunForAuthoritativeCancellation(cancellation);
      throw new Error('execution Run response lost after creation may have happened');
    });

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: cancellation.signal,
      executeAction,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(executeAction).toHaveBeenCalledOnce();
    expect(executeAction).toHaveBeenCalledWith(
      'execution.run.start',
      expect.anything(),
      expect.anything(),
    );
    expect(claimClient.settleExecutionDispatch).not.toHaveBeenCalled();
  });

  it('does not manufacture native stop confirmation when the stop outcome is unknown', async () => {
    const cancellation = new AbortController();
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };
    const executeAction = vi.fn(async (actionId: string) => {
      if (actionId === 'execution.run.start') {
        abortAutomationRunForAuthoritativeCancellation(cancellation);
        return {
          ok: true as const,
          result: {
            runId: 'native-run-stop-outcome-unknown',
            callId: 'native-call-stop-outcome-unknown',
            sidechainId: 'native-sidechain-stop-outcome-unknown',
          },
        };
      }
      return {
        ok: false as const,
        errorCode: 'execution_run_target_unavailable',
        error: 'execution_run_target_unavailable',
      };
    });

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: cancellation.signal,
      executeAction,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(executeAction).toHaveBeenCalledTimes(2);
    expect(executeAction).toHaveBeenLastCalledWith(
      'execution.run.stop',
      { sessionId: null, runId: 'native-run-stop-outcome-unknown' },
      expect.anything(),
    );
    // The stop could not be confirmed, so the identity the start returned is
    // the only remaining pointer to a possibly running execution and is
    // reported. No stop confirmation is manufactured from it.
    expect(claimClient.settleExecutionDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-strict',
        outcome: {
          kind: 'started',
          runId: 'native-run-stop-outcome-unknown',
          callId: 'native-call-stop-outcome-unknown',
          sidechainId: 'native-sidechain-stop-outcome-unknown',
        },
      }),
    );
  });

  it('does not settle a returned execution Run result after ordinary currentness loss', async () => {
    const cancellation = new AbortController();
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };
    const executeAction = vi.fn(async () => {
      cancellation.abort(new Error('Automation Run cancelled'));
      return {
        ok: true as const,
        result: {
          runId: 'native-run-after-cancel',
          callId: 'native-call-after-cancel',
          sidechainId: 'native-sidechain-after-cancel',
        },
      };
    });

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: cancellation.signal,
      executeAction,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(executeAction).toHaveBeenCalledOnce();
    expect(executeAction).toHaveBeenCalledWith(
      'execution.run.start',
      expect.anything(),
      expect.anything(),
    );
    expect(claimClient.settleExecutionDispatch).not.toHaveBeenCalled();
  });

  it('preserves returned Run identity and nested wait failure instead of reclassifying it as a failed start', async () => {
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
      settleExecutionDispatch: vi.fn(async () => {}),
    };
    const wait = { ok: false as const, code: 'timeout' as const };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'must-not-spawn' })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      executeAction: vi.fn(async () => ({
        ok: true as const,
        result: {
          runId: 'native-run-timeout',
          callId: 'native-call-timeout',
          sidechainId: 'native-sidechain-timeout',
          wait,
        },
      })),
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: buildStrictClaimedRun({ recipe: strictExecutionRunRecipe() }),
    });

    expect(claimClient.settleExecutionDispatch).toHaveBeenCalledWith(expect.objectContaining({
      outcome: {
        kind: 'started',
        runId: 'native-run-timeout',
        callId: 'native-call-timeout',
        sidechainId: 'native-sidechain-timeout',
        wait,
      },
    }));
  });

  it('uses the V3 Run-frozen recipe when the Automation definition has since changed', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess_frozen' }));
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };
    const claimedWithFrozenRecipe = {
      protocol: 'v3' as const,
      run: {
        id: 'run-frozen',
        automationId: 'automation-1',
        attempt: 1,
        resultDelivery: { kind: 'none' },
        origin: { kind: 'manual', invokedAt: 1_723_247_201_000 },
        executionInputEnvelope: JSON.stringify({
          kind: 'happier_automation_run_execution_input_v1',
          targetType: 'new_session',
          templateVersion: 1,
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            payload: { directory: '/tmp/frozen-definition' },
          }),
          origin: { kind: 'manual', invokedAt: 1_723_247_201_000 },
        }),
      },
      automation: {
        id: 'automation-1',
        name: 'Edited after admission',
        enabled: true,
      },
      accountCurrentness: CLAIM_CURRENTNESS,
    } satisfies ClaimableRunPayload;

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: claimedWithFrozenRecipe,
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/frozen-definition',
    }));
    expect(claimClient.succeedRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-frozen',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
    }));
  });

  it('retains the V2-frozen V3 Session when its first terminal settlement request loses its response', async () => {
    const sessionId = 'sess-frozen-settlement-fallback';
    const succeedRun = vi.fn().mockRejectedValueOnce(new Error('frozen settlement transport failed before commit'));
    const failRun = vi.fn(async () => {});
    const claimClient = {
      startRun: vi.fn(async () => START_CURRENTNESS),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun,
      failRun,
    };
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId }));
    const claimedWithFrozenRecipe = {
      protocol: 'v3' as const,
      run: {
        id: 'run-frozen-settlement-fallback',
        automationId: 'automation-1',
        attempt: 1,
        resultDelivery: { kind: 'none' },
        origin: { kind: 'manual', invokedAt: 1_723_247_201_000 },
        executionInputEnvelope: JSON.stringify({
          kind: 'happier_automation_run_execution_input_v1',
          targetType: 'new_session',
          templateVersion: 1,
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            payload: { directory: '/tmp/frozen-settlement-fallback' },
          }),
          origin: { kind: 'manual', invokedAt: 1_723_247_201_000 },
        }),
      },
      automation: {
        id: 'automation-1',
        name: 'Frozen settlement fallback',
        enabled: true,
      },
      accountCurrentness: CLAIM_CURRENTNESS,
    } satisfies ClaimableRunPayload;

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce(availableCurrentness(CLAIM_CURRENTNESS))
        .mockResolvedValueOnce(availableCurrentness(START_CURRENTNESS)),
      claimed: claimedWithFrozenRecipe,
    });

    expect(succeedRun).toHaveBeenCalledWith({
      runId: 'run-frozen-settlement-fallback',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: sessionId,
    });
    expect(spawnSession).toHaveBeenCalledOnce();
    expect(failRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-frozen-settlement-fallback',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: sessionId,
      errorCode: 'unexpected_error',
    }));
  });

  it('records a typed locked failure when a retained encrypted template has no account material', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'must-not-spawn',
    }));
    const claimClient = {
      startRun: vi.fn(async () => {}),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      encryption: undefined,
      claimed: buildClaimedRun({
        automation: {
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_encrypted_v1',
            payloadCiphertext: 'retained-ciphertext',
          }),
        },
      }),
    });

    expect(spawnSession).not.toHaveBeenCalled();
    expect(claimClient.failRun).toHaveBeenCalledWith({
      runId: 'run-1',
      machineId: 'machine-1',
      attempt: 1,
      errorCode: 'encryption_material_unavailable',
      errorMessage: 'Encrypted automation template cannot be decrypted without account encryption material',
    });
  });

  it('stops a delayed start after lease heartbeat loss before it can spawn or settle the Run', async () => {
    vi.useFakeTimers();
    try {
      let resolveStart!: () => void;
      const startPending = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'must-not-spawn',
      }));
      const claimClient = {
        startRun: vi.fn(async () => {
          await startPending;
        }),
        heartbeatRun: vi.fn(async () => {
          throw new Error('lease lost');
        }),
        succeedRun: vi.fn(async () => {}),
        failRun: vi.fn(async () => {}),
      };

      const execution = executeClaimedRun({
        token: 'token',
        machineId: 'machine-1',
        claimClient,
        spawnSession,
        heartbeatMs: 1_000,
        leaseDurationMs: 30_000,
        claimed: buildClaimedRun(),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      resolveStart();
      await execution;

      expect(claimClient.heartbeatRun).toHaveBeenCalledOnce();
      expect(spawnSession).not.toHaveBeenCalled();
      expect(claimClient.succeedRun).not.toHaveBeenCalled();
      expect(claimClient.failRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops renewing an aborted Run while an already-started spawn is still resolving', async () => {
    vi.useFakeTimers();
    try {
      const cancellation = new AbortController();
      let resolveSpawn!: (result: SpawnSessionResult) => void;
      const spawnPending = new Promise<SpawnSessionResult>((resolve) => {
        resolveSpawn = resolve;
      });
      const spawnSession = vi.fn(() => spawnPending);
      const claimClient = {
        startRun: vi.fn(async () => {}),
        heartbeatRun: vi.fn(async () => {}),
        succeedRun: vi.fn(async () => {}),
        failRun: vi.fn(async () => {}),
      };

      const execution = executeClaimedRun({
        token: 'token',
        machineId: 'machine-1',
        claimClient,
        spawnSession,
        heartbeatMs: 1_000,
        leaseDurationMs: 30_000,
        signal: cancellation.signal,
        claimed: buildClaimedRun(),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(spawnSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(claimClient.heartbeatRun).toHaveBeenCalledOnce();

      cancellation.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      resolveSpawn({ type: 'success', sessionId: 'must-not-settle' });
      await execution;

      expect(claimClient.heartbeatRun).toHaveBeenCalledOnce();
      expect(claimClient.succeedRun).not.toHaveBeenCalled();
      expect(claimClient.failRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes configured ACP backend state, mcpSelection, connectedServices, transcriptStorage, and session config overrides through to spawnSession for new-session automations', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess_1' }));
    const claimClient = {
      startRun: vi.fn(async () => {}),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      claimed: buildClaimedRun({
        automation: {
          id: 'automation-1',
          name: 'Nightly',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            payload: {
              directory: '/tmp/project',
              backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
              mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-portable'],
                forceExcludeServerIds: ['server-disabled'],
              },
              sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                  reasoning: { updatedAt: 789, value: 'high' },
                },
              },
              connectedServices: {
                v: 1,
                bindingsByServiceId: {
                  anthropic: { source: 'connected', profileId: 'work' },
                },
              },
              transcriptStorage: 'direct',
            },
          }),
        },
      }),
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/project',
      spawnNonce: 'automation:run-1',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-portable'],
        forceExcludeServerIds: ['server-disabled'],
      },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 789,
        overrides: {
          reasoning: { updatedAt: 789, value: 'high' },
        },
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', profileId: 'work' },
        },
      },
      transcriptStorage: 'direct',
    }));
    expect(claimClient.succeedRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      attempt: 1,
      producedSessionId: 'sess_1',
    }));
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it('passes mcpSelection + connectedServices + transcriptStorage through to spawnSession for existing-session automations', async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess_existing' }));
    const claimClient = {
      startRun: vi.fn(async () => {}),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun: vi.fn(async () => {}),
    };

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      claimed: buildClaimedRun({
        run: { id: 'run-2' },
        automation: {
          id: 'automation-1',
          name: 'Nightly existing',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            existingSessionId: 'sess-parent',
            payload: {
              directory: '/tmp/project',
              existingSessionId: 'sess-parent',
              mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-portable'],
                forceExcludeServerIds: ['server-disabled'],
              },
              connectedServices: {
                v: 1,
                bindingsByServiceId: {
                  anthropic: { source: 'connected', profileId: 'work' },
                },
              },
              transcriptStorage: 'direct',
            },
          }),
        },
      }),
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/project',
      existingSessionId: 'sess-parent',
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-portable'],
        forceExcludeServerIds: ['server-disabled'],
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', profileId: 'work' },
        },
      },
      transcriptStorage: 'direct',
    }));
    expect(claimClient.succeedRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-2',
      attempt: 1,
      producedSessionId: 'sess_existing',
    }));
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'accepted first input',
      admission: { status: 'accepted' as const, localId: 'automation:run:run-settlement-fallback' },
      firstSettlement: 'succeed' as const,
    },
    {
      name: 'already-accepted first input',
      admission: { status: 'alreadyAccepted' as const, localId: 'automation:run:run-settlement-fallback' },
      firstSettlement: 'succeed' as const,
    },
    {
      name: 'rejected first input',
      admission: { status: 'rejected' as const, code: 'session_input_invalid' as const },
      firstSettlement: 'fail' as const,
    },
  ])('retains a created V2 Session in the fallback after a pre-commit $name settlement failure', async ({
    admission,
    firstSettlement,
  }) => {
    const sessionId = `session-settlement-fallback-${firstSettlement}-${admission.status}`;
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId }));
    const succeedRun = vi.fn(async () => {});
    const failRun = vi.fn(async () => {});
    if (firstSettlement === 'succeed') {
      succeedRun.mockRejectedValueOnce(new Error('succeed transport failed before commit'));
    } else {
      failRun
        .mockRejectedValueOnce(new Error('fail transport failed before commit'))
        .mockRejectedValueOnce(new Error('fail retry transport failed before commit'))
        .mockResolvedValueOnce(undefined);
    }
    const claimClient = {
      startRun: vi.fn(async () => {}),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun,
      failRun,
    };
    enqueueAutomationPrompt.mockResolvedValueOnce(admission);

    await executeClaimedRun({
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      machineAdmissionTransport: vi.fn(async () => ({
        status: 'accepted' as const,
        localId: 'automation:run:run-settlement-fallback',
      })),
      claimed: buildClaimedRun({
        run: { id: 'run-settlement-fallback' },
        automation: {
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            payload: {
              directory: '/tmp/project',
              prompt: 'Deliver the first automation input.',
            },
          }),
        },
      }),
    });

    expect(spawnSession).toHaveBeenCalledOnce();
    if (firstSettlement === 'succeed') {
      expect(succeedRun).toHaveBeenCalledWith(expect.objectContaining({ producedSessionId: sessionId }));
      expect(failRun).toHaveBeenCalledWith(expect.objectContaining({
        producedSessionId: sessionId,
        errorCode: 'unexpected_error',
      }));
      return;
    }

    expect(succeedRun).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenNthCalledWith(1, expect.objectContaining({
      producedSessionId: sessionId,
      errorCode: 'prompt_delivery_failed',
    }));
    expect(failRun).toHaveBeenNthCalledWith(2, expect.objectContaining({
      producedSessionId: sessionId,
      errorCode: 'prompt_delivery_failed',
    }));
    expect(failRun).toHaveBeenNthCalledWith(3, expect.objectContaining({
      producedSessionId: sessionId,
      errorCode: 'unexpected_error',
    }));
  });

  it('uses the incumbent cancellation settlement fallback when its first transport attempt fails after a V2 Session is created', async () => {
    const cancellation = new AbortController();
    const sessionId = 'session-cancelled-settlement-fallback';
    const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId }));
    const failRun = vi.fn()
      .mockRejectedValueOnce(new Error('cancellation retention transport failed before commit'))
      .mockRejectedValueOnce(new Error('cancellation retention retry transport failed before commit'))
      .mockResolvedValueOnce(undefined);
    const claimClient = {
      startRun: vi.fn(async () => {}),
      heartbeatRun: vi.fn(async () => {}),
      succeedRun: vi.fn(async () => {}),
      failRun,
    };
    enqueueAutomationPrompt.mockImplementationOnce(async () => {
      abortAutomationRunForAuthoritativeCancellation(cancellation);
      return { status: 'accepted' as const, localId: 'automation:run:run-cancelled-settlement-fallback' };
    });

    await executeClaimedRun({
      token: 'token',
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      claimClient,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      signal: cancellation.signal,
      machineAdmissionTransport: vi.fn(async () => ({
        status: 'accepted' as const,
        localId: 'automation:run:run-cancelled-settlement-fallback',
      })),
      claimed: buildClaimedRun({
        run: { id: 'run-cancelled-settlement-fallback' },
        automation: {
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            payload: {
              directory: '/tmp/project',
              prompt: 'Deliver then cancel the first automation input.',
            },
          }),
        },
      }),
    });

    expect(spawnSession).toHaveBeenCalledOnce();
    expect(failRun).toHaveBeenNthCalledWith(1, expect.objectContaining({
      producedSessionId: sessionId,
      errorCode: 'session_start_cancelled_after_create',
    }));
    expect(failRun).toHaveBeenNthCalledWith(2, expect.objectContaining({
      producedSessionId: sessionId,
      errorCode: 'session_start_cancelled_after_create',
    }));
    expect(failRun).toHaveBeenNthCalledWith(3, expect.objectContaining({
      producedSessionId: sessionId,
      errorCode: 'unexpected_error',
    }));
    expect(discardAutomationPromptAfterRunCancellation).toHaveBeenCalledWith({
      token: 'token',
      sessionId,
      automationId: 'automation-1',
      runId: 'run-cancelled-settlement-fallback',
    });
  });
});
