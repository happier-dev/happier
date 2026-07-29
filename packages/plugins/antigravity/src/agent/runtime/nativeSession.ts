import type {
  AgentRuntimeContext,
  AgentSessionMcpService,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { PluginUiQuestion, PluginUiQuestionAnswer } from '@happier-dev/plugin-sdk/runtime';

import { openAntigravityNativeLocalharnessClient } from '../localharness/client/nativeClient.js';
import {
  createAntigravityLocalharnessCredentialResolver,
  createAntigravityLocalharnessSessionRuntime,
  type AntigravityLocalharnessElicitation,
} from '../localharness/runtime/sessionRuntime.js';
import type { AntigravityLocalharnessPermissionRequester } from '../localharness/runtime/permissions.js';
import type { ConcreteAntigravityRuntimeMode } from '../lifecycle/runtimeMode.js';
import { createAntigravityNativeCliPrintExecRun } from '../cliPrint/nativeExec.js';
import { createDefaultCliPrintSessionRuntime } from '../cliPrint/nativeSessionRuntime.js';
import { buildAntigravityRuntimeDescriptorV1 } from './runtimeDescriptor.js';

function composeLaunchEnvironment(request: AgentSessionOpenRequest): Readonly<Record<string, string>> {
  const environment = { ...(request.launchEnvironment?.values ?? {}) };
  for (const key of request.launchEnvironment?.unset ?? []) delete environment[key];
  return environment;
}

function readBoundSessionMcpService(context: AgentRuntimeContext): AgentSessionMcpService | null {
  const session = context.session;
  if (!session || !('services' in session)) return null;
  return (session as AgentSessionRuntimeContext['session']).services.mcp;
}

function createPermissionRequester(
  context: AgentRuntimeContext,
): AntigravityLocalharnessPermissionRequester {
  return async (request) => ({
    decision: await context.ui.confirm(
      `Allow Antigravity to use ${request.toolName}?`,
      { title: 'Antigravity permission' },
    ) ? 'approved' : 'denied',
  });
}

function mapQuestionAnswer(
  answer: PluginUiQuestionAnswer | undefined,
  choices: readonly string[],
): unknown {
  if (!answer) return { textAnswer: { answer: '' } };
  if (answer.type === 'text') return { textAnswer: { answer: answer.value } };
  const selected = answer.type === 'single' ? [answer.answer] : answer.answers;
  const selectedChoiceIndices = selected.flatMap((item) => {
    if (item.type !== 'choice') return [];
    const index = choices.findIndex((_choice, choiceIndex) => String(choiceIndex) === item.choiceId);
    return index >= 0 ? [index] : [];
  });
  return { multipleChoiceAnswer: { selectedChoiceIndices } };
}

function createElicitation(context: AgentRuntimeContext): AntigravityLocalharnessElicitation {
  return async (request) => {
    const questions = request.questions.map((question, index): PluginUiQuestion => {
      const id = question.id?.trim() || `question-${index}`;
      const prompt = question.prompt?.trim() || question.label?.trim() || id;
      const choices = 'choices' in question && Array.isArray(question.choices)
        ? question.choices
        : [];
      return choices.length > 0
        ? {
            id,
            prompt,
            type: 'single',
            choices: choices.map((label, choiceIndex) => ({ id: String(choiceIndex), label })) as [
              { id: string; label: string },
              ...Array<{ id: string; label: string }>,
            ],
          }
        : { id, prompt, type: 'text' };
    });
    if (questions.length === 0) return { status: 'cancelled' };
    const result = await context.ui.askQuestions(
      questions as [PluginUiQuestion, ...PluginUiQuestion[]],
      { title: 'Antigravity question' },
    );
    if (result.status !== 'answered') return { status: result.status };
    return {
      status: 'answered',
      answers: request.questions.map((question, index) => {
        const id = question.id?.trim() || `question-${index}`;
        const choices = 'choices' in question && Array.isArray(question.choices)
          ? question.choices
          : [];
        return mapQuestionAnswer(result.answers[id], choices);
      }),
    };
  };
}

export function createAntigravityNativeSessionRuntime(input: Readonly<{
  mode: ConcreteAntigravityRuntimeMode;
  request: AgentSessionOpenRequest;
  context: AgentRuntimeContext;
}>): AgentSessionRuntime {
  const env = composeLaunchEnvironment(input.request);
  if (input.mode === 'cliPrint') {
    const providerSessionId = input.request.kind === 'resume'
      ? input.request.providerSessionId
      : input.request.kind === 'fork'
        ? input.request.source.providerSessionId
        : null;
    return createDefaultCliPrintSessionRuntime({
      sessionParams: {
        sessionId: input.request.sessionId,
        cwd: input.request.cwd,
        env,
        ...(input.request.configuration?.model.value
          ? { modelId: input.request.configuration.model.value }
          : {}),
        ...(providerSessionId
          ? {
              metadata: {
                runtimeDescriptorV1: buildAntigravityRuntimeDescriptorV1({
                  runtimeMode: 'cliPrint',
                  providerSessionId,
                  agyConversationId: providerSessionId,
                }),
              },
            }
          : {}),
      },
      runAgentCli: createAntigravityNativeCliPrintExecRun(input.context.services.exec),
    });
  }
  return createAntigravityLocalharnessSessionRuntime({
    sessionId: input.request.sessionId,
    cwd: input.request.cwd,
    modelId: input.request.configuration?.model.value,
    openClient: ({ requestFrame }) => openAntigravityNativeLocalharnessClient({
      exec: input.context.services.exec,
      requestFrame,
      signal: input.context.signal,
    }),
    requestPermission: createPermissionRequester(input.context),
    elicit: createElicitation(input.context),
    resolveCredentials: createAntigravityLocalharnessCredentialResolver({ env }),
    resolveMcpServers: () => {
      const mcp = readBoundSessionMcpService(input.context);
      return mcp
        ? mcp.resolveServers({ signal: input.context.signal })
        : Promise.resolve([]);
    },
  });
}
