import type { ProviderScenario, ProviderUnderTest } from '../types';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  callSessionScopedRpc,
  enqueueSessionPromptForScenario,
  waitForAssistantMessageContaining,
} from './sessionRuntime';
import { fetchSessionV2, patchSessionMetadataWithRetry } from '../../sessions';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../messageCrypto';
import { sleep } from '../../timing';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertGrokStub(provider: ProviderUnderTest, scenarioId: string): void {
  if (provider.id !== 'grok_acp_stub' || provider.cli.subcommand !== 'grok') {
    throw new Error(`${scenarioId} requires the deterministic Grok ACP stub`);
  }
}

async function assertReportedGrokModelState(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
}>): Promise<void> {
  const session = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
  const metadata = decryptLegacyBase64(session.metadata, params.secret);
  const models = isRecord(metadata) && isRecord(metadata.acpSessionModelsV1)
    ? metadata.acpSessionModelsV1
    : null;
  if (models?.currentModelId !== 'grok-4.5' || !Array.isArray(models.availableModels)) {
    throw new Error('grok stub: expected reported Grok model state');
  }
  const model = models.availableModels.find((candidate) => isRecord(candidate) && candidate.id === 'grok-4.5');
  const effort = isRecord(model) && Array.isArray(model.modelOptions)
    ? model.modelOptions.find((option) => isRecord(option) && option.id === 'reasoning_effort')
    : null;
  if (!isRecord(effort)) {
    throw new Error('grok stub: reported Grok state omitted normalized reasoning effort');
  }
}

export function makeGrokAcpStubAuthCreateResumeScenario(provider: ProviderUnderTest): ProviderScenario {
  const id = 'grok_acp_stub_auth_create_resume';
  assertGrokStub(provider, id);
  return {
    id,
    title: 'grok stub: authenticates before create and resumes exact vendor identity',
    tier: 'smoke',
    yolo: true,
    prompt: () => 'GROK_STUB_AUTH_CREATE_RESUME',
    requiredMessageSubstrings: ['GROK_STUB_READY'],
    resume: {
      metadataKey: 'grokSessionId',
      freshSession: true,
      prompt: () => 'GROK_STUB_AUTH_CREATE_RESUME_RESUMED',
      requiredTraceSubstrings: [],
    },
    verify: async ({ baseUrl, token, sessionId, resumeSessionId, secret }) => {
      await assertReportedGrokModelState({ baseUrl, token, sessionId, secret });
      if (!resumeSessionId) {
        throw new Error('grok stub: expected a fresh Happier resume session');
      }
      await assertReportedGrokModelState({ baseUrl, token, sessionId: resumeSessionId, secret });
    },
  };
}

export function makeGrokAcpStubStructuredQuestionScenario(provider: ProviderUnderTest): ProviderScenario {
  const id = 'grok_acp_stub_structured_question';
  assertGrokStub(provider, id);
  return {
    id,
    title: 'grok stub: preserves comma-bearing and reserved-key multi-select answers',
    tier: 'smoke',
    yolo: false,
    permissionAutoDecision: 'approved',
    permissionAutoStructuredAnswersV1: Object.freeze(Object.assign(Object.create(null), {
      location: Object.freeze(['Washington, D.C.', '__proto__']),
    })),
    prompt: () => 'GROK_STUB_STRUCTURED_QUESTION',
    requiredMessageSubstrings: [
      'GROK_STUB_QUESTION_RESULT',
      'Washington, D.C.',
      '__proto__',
    ],
    maxTraceEvents: { permissionRequests: 2 },
    postSatisfy: {
      timeoutMs: 60_000,
      run: async ({ baseUrl, token, sessionId, secret }) => {
        await enqueueSessionPromptForScenario({
          baseUrl,
          token,
          sessionId,
          secret,
          text: 'GROK_STUB_STRUCTURED_QUESTION_WRAPPED',
        });
        await waitForAssistantMessageContaining({
          baseUrl,
          token,
          sessionId,
          secret,
          requiredSubstring: 'GROK_STUB_QUESTION_RESULT_WRAPPED',
          timeoutMs: 60_000,
        });
      },
    },
  };
}

export function makeGrokAcpStubFreeformQuestionScenario(provider: ProviderUnderTest): ProviderScenario {
  const id = 'grok_acp_stub_freeform_question';
  assertGrokStub(provider, id);
  const typed = 'Keep commas, exactly\nand preserve the newline';
  return {
    id,
    title: 'grok stub: maps zero-option freeform through Other plus exact notes',
    tier: 'smoke',
    yolo: false,
    permissionAutoDecision: 'approved',
    permissionAutoStructuredAnswersV1: Object.freeze({ details: Object.freeze([typed]) }),
    prompt: () => 'GROK_STUB_FREEFORM_QUESTION',
    requiredMessageSubstrings: [
      'GROK_STUB_QUESTION_RESULT',
      'Describe the change',
      'Other',
      'Keep commas, exactly',
      'preserve the newline',
    ],
    maxTraceEvents: { permissionRequests: 2 },
  };
}

export function makeGrokAcpStubMixedFreeformQuestionScenario(provider: ProviderUnderTest): ProviderScenario {
  const id = 'grok_acp_stub_mixed_freeform_question';
  assertGrokStub(provider, id);
  const typed = 'A custom, multiline\nlocation';
  return {
    id,
    title: 'grok stub: preserves option plus freeform through Other and notes',
    tier: 'smoke',
    yolo: false,
    permissionAutoDecision: 'approved',
    permissionAutoStructuredAnswersV1: Object.freeze({
      locations: Object.freeze(['Washington, D.C.', typed]),
    }),
    prompt: () => 'GROK_STUB_MIXED_FREEFORM_QUESTION',
    requiredMessageSubstrings: [
      'GROK_STUB_QUESTION_RESULT',
      'Washington, D.C.',
      'Other',
      'A custom, multiline',
      'location',
    ],
    maxTraceEvents: { permissionRequests: 2 },
  };
}

function readRecordedRequests(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord);
}

function hasSetModelRequest(
  requests: ReadonlyArray<Record<string, unknown>>,
  modelId: string,
  reasoningEffort: string,
): boolean {
  return requests.some((request) => {
    if (request.method !== 'session/set_model') return false;
    const params = isRecord(request.params) ? request.params : null;
    const meta = isRecord(params?._meta) ? params._meta : null;
    return params?.modelId === modelId && meta?.reasoningEffort === reasoningEffort;
  });
}

function hasModelRequest(requests: ReadonlyArray<Record<string, unknown>>, modelId: string): boolean {
  return requests.some((request) => {
    if (request.method !== 'session/set_model') return false;
    const params = isRecord(request.params) ? request.params : null;
    return params?.modelId === modelId;
  });
}

export function makeGrokAcpStubModelsAndEffortScenario(provider: ProviderUnderTest): ProviderScenario {
  const id = 'grok_acp_stub_models_and_effort';
  assertGrokStub(provider, id);
  return {
    id,
    title: 'grok stub: projects effort metadata and keeps failed switches non-authoritative',
    tier: 'smoke',
    yolo: true,
    prompt: () => 'GROK_STUB_MODELS_AND_EFFORT',
    requiredMessageSubstrings: ['GROK_STUB_READY'],
    postSatisfy: {
      timeoutMs: 120_000,
      run: async ({ baseUrl, token, sessionId, secret, cliHome }) => {
        const initial = await fetchSessionV2(baseUrl, token, sessionId);
        const initialMetadata = decryptLegacyBase64(initial.metadata, secret);
        const initialMetadataRecord = isRecord(initialMetadata) ? initialMetadata : {};
        const initialModels = isRecord(initialMetadataRecord.acpSessionModelsV1)
          ? initialMetadataRecord.acpSessionModelsV1
          : null;
        if (initialModels?.currentModelId !== 'grok-4.5' || !Array.isArray(initialModels.availableModels)) {
          throw new Error('grok stub: create state omitted the advertised current model inventory');
        }
        const grok45 = initialModels.availableModels.find(
          (model) => isRecord(model) && model.id === 'grok-4.5',
        );
        const grokFast = initialModels.availableModels.find(
          (model) => isRecord(model) && model.id === 'grok-4.1-fast',
        );
        const grok45Effort = isRecord(grok45) && Array.isArray(grok45.modelOptions)
          ? grok45.modelOptions.find((option) => isRecord(option) && option.id === 'reasoning_effort')
          : null;
        const grokFastEffort = isRecord(grokFast) && Array.isArray(grokFast.modelOptions)
          ? grokFast.modelOptions.find((option) => isRecord(option) && option.id === 'reasoning_effort')
          : null;
        if (!isRecord(grok45Effort) || !isRecord(grokFastEffort)) {
          throw new Error('grok stub: advertised models omitted per-model reasoning effort controls');
        }

        const updatedAt = Date.now();
        await patchSessionMetadataWithRetry({
          baseUrl,
          token,
          sessionId,
          ciphertext: encryptLegacyBase64({
            ...initialMetadataRecord,
            acpConfigOptionOverridesV1: {
              v: 1,
              updatedAt,
              overrides: { reasoning_effort: { updatedAt, value: 'high' } },
            },
          }, secret),
          expectedVersion: initial.metadataVersion,
        });

        const recordPath = join(cliHome, 'grok-acp-stub', 'requests.jsonl');
        const effortDeadline = Date.now() + 60_000;
        while (Date.now() < effortDeadline) {
          const raw = await readFile(recordPath, 'utf8').catch(() => '');
          const requests = readRecordedRequests(raw);
          if (hasSetModelRequest(requests, 'grok-4.5', 'high')) break;
          await sleep(250);
        }

        const afterEffort = await fetchSessionV2(baseUrl, token, sessionId);
        const afterEffortMetadata = decryptLegacyBase64(afterEffort.metadata, secret);
        const afterEffortMetadataRecord = isRecord(afterEffortMetadata) ? afterEffortMetadata : {};
        const afterEffortModels = isRecord(afterEffortMetadataRecord.acpSessionModelsV1)
          ? afterEffortMetadataRecord.acpSessionModelsV1
          : null;
        const effortRequests = readRecordedRequests(await readFile(recordPath, 'utf8').catch(() => ''));
        if (!hasSetModelRequest(effortRequests, 'grok-4.5', 'high')) {
          throw new Error('grok stub: exact model/effort set_model request was not observed');
        }
        if (afterEffortModels?.currentModelId !== 'grok-4.5') {
          throw new Error('grok stub: effort update changed the authoritative model id');
        }

        const failedAt = updatedAt + 1;
        await patchSessionMetadataWithRetry({
          baseUrl,
          token,
          sessionId,
          ciphertext: encryptLegacyBase64({
            ...afterEffortMetadataRecord,
            modelOverrideV1: { v: 1, updatedAt: failedAt, modelId: 'grok-switch-fails' },
          }, secret),
          expectedVersion: afterEffort.metadataVersion,
        });

        const failureDeadline = Date.now() + 30_000;
        while (Date.now() < failureDeadline) {
          const requests = readRecordedRequests(await readFile(recordPath, 'utf8').catch(() => ''));
          if (hasModelRequest(requests, 'grok-switch-fails')) break;
          await sleep(250);
        }
        const afterFailure = await fetchSessionV2(baseUrl, token, sessionId);
        const afterFailureMetadata = decryptLegacyBase64(afterFailure.metadata, secret);
        const afterFailureModels = isRecord(afterFailureMetadata) && isRecord(afterFailureMetadata.acpSessionModelsV1)
          ? afterFailureMetadata.acpSessionModelsV1
          : null;
        const failureRequests = readRecordedRequests(await readFile(recordPath, 'utf8').catch(() => ''));
        if (!hasModelRequest(failureRequests, 'grok-switch-fails')) {
          throw new Error('grok stub: failed switch request was not observed');
        }
        if (afterFailureModels?.currentModelId !== 'grok-4.5') {
          throw new Error('grok stub: failed switch overwrote authoritative current model state');
        }
      },
    },
  };
}

export function makeGrokAcpStubCancelAndCapabilitiesScenario(provider: ProviderUnderTest): ProviderScenario {
  const id = 'grok_acp_stub_cancel_and_capabilities';
  assertGrokStub(provider, id);
  const ready = 'GROK_STUB_LIFECYCLE_SCENARIO_READY';
  const after = 'GROK_STUB_LIFECYCLE_SCENARIO_AFTER';
  return {
    id,
    title: 'grok stub: cancel terminalizes one turn and permits a follow-up',
    tier: 'smoke',
    yolo: true,
    prompt: () => ready,
    requiredMessageSubstrings: [ready],
    postSatisfy: {
      timeoutMs: 120_000,
      run: async ({ baseUrl, token, sessionId, secret }) => {
        await enqueueSessionPromptForScenario({
          baseUrl,
          token,
          sessionId,
          secret,
          text: 'GROK_STUB_CANCEL',
        });
        await waitForAssistantMessageContaining({
          baseUrl,
          token,
          sessionId,
          secret,
          requiredSubstring: 'GROK_STUB_CANCEL_PENDING',
          timeoutMs: 30_000,
        });
        await callSessionScopedRpc({
          baseUrl,
          token,
          sessionId,
          method: 'abort',
          payload: {},
          secret,
          timeoutMs: 30_000,
        });
        await enqueueSessionPromptForScenario({
          baseUrl,
          token,
          sessionId,
          secret,
          text: after,
        });
        await waitForAssistantMessageContaining({
          baseUrl,
          token,
          sessionId,
          secret,
          requiredSubstring: after,
          timeoutMs: 30_000,
        });
      },
    },
    verify: async ({ baseUrl, token, sessionId, secret }) => {
      const session = await fetchSessionV2(baseUrl, token, sessionId);
      const metadata = decryptLegacyBase64(session.metadata, secret);
      if (!isRecord(metadata) || metadata.grokSessionId !== 'grok-stub-session-1') {
        throw new Error('grok stub: expected the bound vendor session id in canonical metadata');
      }
      const models = metadata.acpSessionModelsV1;
      if (!isRecord(models) || models.currentModelId !== 'grok-4.5' || !Array.isArray(models.availableModels)) {
        throw new Error('grok stub: expected advertised Grok model state in canonical metadata');
      }
      const hasGrok45 = models.availableModels.some(
        (model) => isRecord(model) && model.id === 'grok-4.5',
      );
      if (!hasGrok45) {
        throw new Error('grok stub: advertised model state omitted grok-4.5');
      }
      const agentState = session.agentState ? decryptLegacyBase64(session.agentState, secret) : null;
      const capabilities = isRecord(agentState) && isRecord(agentState.capabilities)
        ? agentState.capabilities
        : null;
      if (capabilities?.structuredQuestionAnswersV1Supported !== true) {
        throw new Error('grok stub: structured-question v1 capability was not published');
      }
    },
  };
}
