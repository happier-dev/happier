import type { ProviderScenario, ProviderUnderTest } from '../types';
import {
  callSessionScopedRpc,
  enqueueSessionPromptForScenario,
  waitForAssistantMessageContaining,
} from './sessionRuntime';
import { fetchSessionV2 } from '../../sessions';
import { decryptLegacyBase64 } from '../../messageCrypto';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertGrokStub(provider: ProviderUnderTest, scenarioId: string): void {
  if (provider.id !== 'grok_acp_stub' || provider.cli.subcommand !== 'grok') {
    throw new Error(`${scenarioId} requires the deterministic Grok ACP stub`);
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
      if (!isRecord(models) || models.currentModelId !== 'grok-build' || !Array.isArray(models.availableModels)) {
        throw new Error('grok stub: expected advertised Grok model state in canonical metadata');
      }
      const hasGrokBuild = models.availableModels.some(
        (model) => isRecord(model) && model.id === 'grok-build',
      );
      if (!hasGrokBuild) {
        throw new Error('grok stub: advertised model state omitted grok-build');
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
