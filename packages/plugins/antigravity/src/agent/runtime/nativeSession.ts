import type {
  AgentSessionMcpServer,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  InteractionTransientAuthorQuestionV1,
  InteractionTransientQuestionAnswerV1,
} from '@happier-dev/plugin-sdk/interactions';

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

function composeLaunchEnvironment(request: AgentSessionOpenRequest): Readonly<Record<string, string>> {
  const environment = { ...(request.launchEnvironment?.values ?? {}) };
  for (const key of request.launchEnvironment?.unset ?? []) delete environment[key];
  return environment;
}

type AntigravityNativeRuntimeInput = Readonly<{
  mode: ConcreteAntigravityRuntimeMode;
  request: AgentSessionOpenRequest;
  context: AgentSessionRuntimeContext;
  connectedAccountEnv?: Readonly<Record<string, string>>;
  materializeAuthEnv?: () => Promise<Readonly<Record<string, string>> | null>;
}>;

type AntigravityMcpServerResolver = () => Promise<readonly AgentSessionMcpServer[]>;

function createPermissionRequester(
  context: AgentSessionRuntimeContext,
): AntigravityLocalharnessPermissionRequester {
  return async (request) => {
    const result = await context.services.interactions.confirm({
      kind: 'confirmation',
      title: 'Antigravity permission',
      message: `Allow Antigravity to use ${request.toolName}?`,
    });
    return { decision: result.status === 'approved' ? 'approved' : 'denied' };
  };
}

function mapQuestionAnswer(
  answer: InteractionTransientQuestionAnswerV1 | undefined,
  choices: readonly string[],
): unknown {
  if (!answer) return { textAnswer: { answer: '' } };
  if (answer.kind === 'text') return { textAnswer: { answer: answer.value } };
  const selected = answer.kind === 'singleChoice' ? [answer.answer] : answer.answers;
  const selectedChoiceIndices = selected.flatMap((item) => {
    if (item.kind !== 'choice') return [];
    const index = choices.findIndex((_choice, choiceIndex) => String(choiceIndex) === item.choiceId);
    return index >= 0 ? [index] : [];
  });
  return { multipleChoiceAnswer: { selectedChoiceIndices } };
}

function createElicitation(context: AgentSessionRuntimeContext): AntigravityLocalharnessElicitation {
  return async (request) => {
    const questions = request.questions.map((question, index): InteractionTransientAuthorQuestionV1 => {
      const id = question.id?.trim() || `question-${index}`;
      const prompt = question.prompt?.trim() || question.label?.trim() || id;
      const choices = 'choices' in question && Array.isArray(question.choices)
        ? question.choices
        : [];
      return choices.length > 0
        ? {
            id,
            prompt,
            type: 'singleChoice',
            choices: choices.map((label, choiceIndex) => ({ id: String(choiceIndex), label })) as [
              { id: string; label: string },
              ...Array<{ id: string; label: string }>,
            ],
          }
        : { id, prompt, type: 'text' };
    });
    if (questions.length === 0) return { status: 'cancelled' };
    const result = await context.services.interactions.askQuestions({
      kind: 'questions',
      title: 'Antigravity question',
      questions: questions as [InteractionTransientAuthorQuestionV1, ...InteractionTransientAuthorQuestionV1[]],
    });
    if (result.status !== 'answered') return { status: 'cancelled' };
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

function createAntigravityNativeRuntimeWithMcp(
  input: AntigravityNativeRuntimeInput,
  resolveMcpServers: AntigravityMcpServerResolver,
): AgentSessionRuntime {
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
        ...(input.connectedAccountEnv
          ? { connectedAccountEnv: input.connectedAccountEnv }
          : {}),
        ...(input.request.configuration?.model.value
          ? { modelId: input.request.configuration.model.value }
          : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
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
    resolveCredentials: createAntigravityLocalharnessCredentialResolver({
      env,
      ...(input.materializeAuthEnv
        ? { materializeAuthEnv: input.materializeAuthEnv }
        : {}),
    }),
    resolveMcpServers,
  });
}

export function createAntigravityNativeSessionRuntime(
  input: AntigravityNativeRuntimeInput,
): AgentSessionRuntime {
  return createAntigravityNativeRuntimeWithMcp(
    input,
    () => input.context.session.services.mcp.resolveServers({
      signal: input.context.signal,
    }),
  );
}
