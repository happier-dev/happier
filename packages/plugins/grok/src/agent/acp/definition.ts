import type {
  AgentAcpRuntimeDefinition,
  AgentAcpRuntimeExtensions,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createAcpToolNameInferencePreset } from '@happier-dev/plugin-sdk/agents/runtime';

import { selectGrokAuthentication } from './auth.js';
import { GROK_PROMPT_COMPLETE_METHODS, handleGrokPromptComplete } from './completion.js';
import { GROK_MCP_SERVERS_UPDATED_METHOD, handleGrokMcpServersUpdated } from './mcpServersUpdated.js';
import {
  projectGrokModel,
  projectGrokSetModelResponse,
  resolveGrokReasoningEffortUpdate,
} from './modelControls.js';
import {
  buildGrokHostQuestions,
  buildGrokQuestionResponse,
  GROK_ASK_USER_QUESTION_METHODS,
  parseGrokQuestionRequest,
} from './questions.js';
import { projectGrokGeneratedMedia } from './generatedMedia.js';
import { GROK_ACP_HISTORY } from './historyControls.js';
import { GROK_PROMPT_USAGE } from './usage.js';
import {
  createGrokSessionNotificationObserver,
  GROK_SESSION_NOTIFICATION_METHODS,
} from './sessionNotifications.js';

export function buildGrokAcpRuntimeDefinition(
  launchEnvironment: Readonly<Record<string, string>>,
): AgentAcpRuntimeDefinition {
  return Object.freeze({
    auth: {
      selectMethod: (context) => selectGrokAuthentication(context, launchEnvironment),
    },
    parameterizedModelPicker: true,
    acceptsVerifiedImageInput: true,
    toolNameInference: createAcpToolNameInferencePreset(),
    toolUpdates: {
      minInProgressIntervalMs: 250,
      maxStringChars: 8_192,
    },
    models: {
      projectModel(rawModel, normalizedModel) {
        const modelRecord = rawModel !== null && typeof rawModel === 'object' && !Array.isArray(rawModel)
          ? rawModel as Readonly<Record<string, unknown>>
          : {};
        return projectGrokModel(modelRecord, normalizedModel);
      },
      projectUpdate({ configId, value, currentModel }) {
        return resolveGrokReasoningEffortUpdate({ configId, value, currentModel });
      },
      projectSetModelResponse(input) {
        return projectGrokSetModelResponse(input);
      },
    },
    generatedMedia: {
      projectTerminalOutput: projectGrokGeneratedMedia,
    },
    delivery: {
      steer: {
        method: 'x.ai/interject',
        buildParams({ providerSessionId, inputIds, input }) {
          return {
            sessionId: providerSessionId,
            text: input.text,
            interjectionId: inputIds[0],
          };
        },
        isAccepted(response) {
          return response !== null
            && typeof response === 'object'
            && !Array.isArray(response)
            && Reflect.get(response, 'status') === 'queued';
        },
      },
    },
    usage: GROK_PROMPT_USAGE,
    history: GROK_ACP_HISTORY,
    mcp: { policy: 'pass_through' as const },
  });
}

export const GROK_ACP_RUNTIME_DEFINITION: AgentAcpRuntimeDefinition =
  buildGrokAcpRuntimeDefinition({});

export function createGrokAcpRuntimeExtensions(
  context: Readonly<{
    services: AgentSessionRuntimeContext['services'];
    session: AgentSessionRuntimeContext['session'];
    workState: AgentSessionRuntimeContext['workState'];
  }>,
): AgentAcpRuntimeExtensions {
  const sessionNotification = createGrokSessionNotificationObserver({
    context,
  });
  const askQuestion = async (
    params: Parameters<NonNullable<AgentAcpRuntimeExtensions['requests']>[string]>[0],
    extensionContext: Parameters<NonNullable<AgentAcpRuntimeExtensions['requests']>[string]>[1],
  ) => {
    if (extensionContext.signal.aborted) return { outcome: 'cancelled' };
    if (!extensionContext.providerSessionId) {
      throw new Error('Grok question arrived before an ACP provider session was bound');
    }
    if (!extensionContext.currentTurn) {
      throw new Error('Grok question arrived without an active ACP turn');
    }
    const request = parseGrokQuestionRequest(
      params,
      extensionContext.providerSessionId,
      extensionContext.method,
    );
    const result = await context.services.interactions.askQuestions({
      kind: 'questions',
      title: request.mode === 'plan' ? 'Grok plan question' : 'Grok question',
      questions: buildGrokHostQuestions(request),
    }, { signal: extensionContext.signal });
    if (extensionContext.signal.aborted) return { outcome: 'cancelled' };
    return buildGrokQuestionResponse(request, result);
  };

  return Object.freeze({
    requests: Object.freeze(Object.fromEntries(
      GROK_ASK_USER_QUESTION_METHODS.map((method) => [method, askQuestion]),
    )),
    notifications: Object.freeze({
      ...Object.fromEntries(GROK_PROMPT_COMPLETE_METHODS.map((method) => [
        method,
        (params: Parameters<typeof handleGrokPromptComplete>[0], extensionContext: Parameters<typeof handleGrokPromptComplete>[1]) => {
          handleGrokPromptComplete(params, extensionContext);
        },
      ])),
      [GROK_MCP_SERVERS_UPDATED_METHOD]: handleGrokMcpServersUpdated,
      ...Object.fromEntries(GROK_SESSION_NOTIFICATION_METHODS.map((method) => [method, sessionNotification])),
    }),
  });
}
