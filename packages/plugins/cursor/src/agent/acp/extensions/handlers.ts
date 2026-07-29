import { createHash } from 'node:crypto';

import type {
  AgentAcpExtensionContext,
  AgentAcpNotificationExtension,
  AgentAcpRequestExtension,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

import { createCursorTodoWorkStateUpdater } from '../workState/projection.js';
import { buildCursorPlanPermissionInput, buildCursorPlanResponse } from './plans.js';
import { buildCursorHostQuestions, buildCursorQuestionAnswers } from './questions.js';
import {
  cursorAskQuestionRequestSchema,
  cursorAskQuestionResponseSchema,
  cursorCreatePlanRequestSchema,
  cursorGenerateImageNotificationSchema,
  cursorTaskNotificationSchema,
  cursorUpdateTodosRequestSchema,
} from './schemas.js';
import { readCursorPlanTodos, readCursorTodos } from './todos.js';

function readPayloadKeys(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(Object.keys(value).sort());
}

function cursorTaskKind(subagentType: unknown): 'native' | 'custom' {
  return typeof subagentType === 'object' && subagentType !== null && !Array.isArray(subagentType)
    ? 'custom'
    : 'native';
}

function cursorNativeTaskObservationId(task: Readonly<{ toolCallId: string; agentId: string }>): string {
  const digest = createHash('sha256')
    .update('happier-cursor-native-task-v1\0', 'utf8')
    .update(task.toolCallId, 'utf8')
    .update('\0', 'utf8')
    .update(task.agentId, 'utf8')
    .digest('base64url');
  return `cursor-native:${digest.slice(0, 32)}`;
}

const GENERATED_MEDIA_DEDUPE_LIMIT = 256;

type GeneratedMediaPublication = Readonly<{
  promise: Promise<void>;
  settled: { value: boolean };
}>;

function evictCompletedGeneratedMediaPublications(
  publications: Map<string, GeneratedMediaPublication>,
  maxEntries = GENERATED_MEDIA_DEDUPE_LIMIT,
): void {
  while (publications.size > maxEntries) {
    const completed = [...publications.entries()].find(([, publication]) => publication.settled.value);
    if (!completed) return;
    publications.delete(completed[0]);
  }
}

function waitForGeneratedMediaSettlementOrAbort(
  publication: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) return publication.then(() => true, () => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => settle(false);
    signal.addEventListener('abort', onAbort, { once: true });
    publication.then(
      () => settle(true),
      () => settle(true),
    );
  });
}

async function awaitGeneratedMediaPublicationCapacity(
  publications: Map<string, GeneratedMediaPublication>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  while (publications.size >= GENERATED_MEDIA_DEDUPE_LIMIT) {
    if (signal?.aborted) return false;
    evictCompletedGeneratedMediaPublications(publications, GENERATED_MEDIA_DEDUPE_LIMIT - 1);
    if (publications.size < GENERATED_MEDIA_DEDUPE_LIMIT) return true;

    const inFlight = [...publications.values()].find((publication) => !publication.settled.value);
    if (!inFlight) {
      await Promise.resolve();
      continue;
    }
    if (!await waitForGeneratedMediaSettlementOrAbort(inFlight.promise, signal)) return false;
  }
  return true;
}

function readPlanTitle(name: string | undefined): string {
  return name ?? 'Approve Cursor plan';
}

export function createCursorAcpExtensionHandlers(params: Readonly<{
  context: AgentSessionRuntimeContext;
  mediaSourceRoot?: string;
}>) {
  const updateCursorTodoWorkState = createCursorTodoWorkStateUpdater(params.context);
  const generatedMediaPublications = new Map<string, GeneratedMediaPublication>();
  let generatedMediaAdmission = Promise.resolve();

  async function acquireGeneratedMediaPublication(
    localId: string,
    createPublication: () => Promise<void>,
    signal: AbortSignal | undefined,
  ): Promise<GeneratedMediaPublication | null> {
    let releaseAdmission!: () => void;
    const previousAdmission = generatedMediaAdmission;
    generatedMediaAdmission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    try {
      if (!await waitForGeneratedMediaSettlementOrAbort(previousAdmission, signal)) return null;
      if (signal?.aborted) return null;
      const existing = generatedMediaPublications.get(localId);
      if (existing) return existing;

      if (!await awaitGeneratedMediaPublicationCapacity(generatedMediaPublications, signal)) return null;
      const publication = createPublication();
      const entry: GeneratedMediaPublication = {
        promise: publication,
        settled: { value: false },
      };
      generatedMediaPublications.set(localId, entry);
      void publication.then(
        () => {
          entry.settled.value = true;
          evictCompletedGeneratedMediaPublications(generatedMediaPublications);
        },
        () => {
          if (generatedMediaPublications.get(localId) === entry) {
            generatedMediaPublications.delete(localId);
          }
        },
      );
      return entry;
    } finally {
      releaseAdmission();
    }
  }

  const askQuestion: AgentAcpRequestExtension = async (extensionParams, extensionContext) => {
    const request = cursorAskQuestionRequestSchema.parse(extensionParams);
    if (extensionContext.signal.aborted) {
      return cursorAskQuestionResponseSchema.parse({ outcome: { outcome: 'cancelled' } });
    }
    const result = await params.context.ui.askQuestions(
      buildCursorHostQuestions(request),
      { title: request.title ?? 'Question' },
    );
    if (result.status === 'cancelled' || extensionContext.signal.aborted) {
      return cursorAskQuestionResponseSchema.parse({ outcome: { outcome: 'cancelled' } });
    }
    if (result.status === 'unavailable') {
      return cursorAskQuestionResponseSchema.parse({
        outcome: { outcome: 'skipped', reason: result.diagnostic.message },
      });
    }
    const answers = buildCursorQuestionAnswers(request, result);
    return cursorAskQuestionResponseSchema.parse(answers.length > 0
      ? { outcome: { outcome: 'answered', answers } }
      : { outcome: { outcome: 'skipped' } });
  };

  const createPlan: AgentAcpRequestExtension = async (extensionParams, extensionContext) => {
    const request = cursorCreatePlanRequestSchema.parse(extensionParams);
    if (request.todos !== undefined || request.phases !== undefined) {
      await updateCursorTodoWorkState({
        todos: readCursorPlanTodos(request),
        merge: false,
        signal: extensionContext.signal,
      });
    }
    if (extensionContext.signal.aborted) return buildCursorPlanResponse('cancelled');
    try {
      const confirmed = await params.context.ui.confirm(
        buildCursorPlanPermissionInput(request),
        { title: readPlanTitle(request.name) },
      );
      return buildCursorPlanResponse(confirmed ? 'accepted' : 'rejected');
    } catch (error) {
      if (error instanceof PluginError && error.code === 'plugin_ui_cancelled') {
        return buildCursorPlanResponse('cancelled');
      }
      throw error;
    }
  };

  async function handleUpdateTodos(
    extensionParams: unknown,
    extensionContext: AgentAcpExtensionContext,
  ): Promise<void> {
    const parsed = cursorUpdateTodosRequestSchema.safeParse(extensionParams);
    if (!parsed.success) {
      params.context.services.logger.debug('Cursor ACP update_todos ignored malformed payload', {
        keys: readPayloadKeys(extensionParams),
      });
      return;
    }
    await updateCursorTodoWorkState({
      todos: readCursorTodos(parsed.data),
      merge: parsed.data.merge === true,
      signal: extensionContext.signal,
    });
  }

  const updateTodosRequest: AgentAcpRequestExtension = async (extensionParams, extensionContext) => {
    await handleUpdateTodos(extensionParams, extensionContext);
    return {};
  };
  const updateTodosNotification: AgentAcpNotificationExtension = handleUpdateTodos;

  async function handleTask(
    extensionParams: unknown,
    extensionContext: AgentAcpExtensionContext,
  ): Promise<void> {
    const parsed = cursorTaskNotificationSchema.safeParse(extensionParams);
    if (!parsed.success) {
      params.context.services.logger.debug('Cursor ACP task ignored malformed payload', {
        keys: readPayloadKeys(extensionParams),
      });
      return;
    }
    const task = parsed.data;
    const agentId = task.agentId;
    const toolCallId = task.toolCallId;
    if (agentId === undefined || toolCallId === undefined) {
      params.context.services.logger.debug('Cursor ACP task ignored without source identifiers', {
        keys: readPayloadKeys(extensionParams),
      });
      return;
    }
    const observationId = cursorNativeTaskObservationId({ toolCallId, agentId });
    await params.context.services.sessions.subagents.observe({
      observationId,
      status: 'completed',
      detail: {
        origin: 'agent',
        kind: cursorTaskKind(task.subagentType),
        agentRef: { agentId: 'cursor', agentKind: 'cursor-task' },
        spawnRef: { toolCallId },
        label: task.description ?? agentId,
        agentMetadata: {
          ...(task.model === undefined ? {} : { model: task.model }),
          agentId,
          ...(task.subagentType === undefined ? {} : { subagentType: task.subagentType }),
          ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
        },
      },
    }, { signal: extensionContext.signal });
  }
  const taskRequest: AgentAcpRequestExtension = async (extensionParams, extensionContext) => {
    await handleTask(extensionParams, extensionContext);
    return {};
  };
  const taskNotification: AgentAcpNotificationExtension = handleTask;

  const generatedMediaNotification: AgentAcpNotificationExtension = async (value, extensionContext) => {
    const parsed = cursorGenerateImageNotificationSchema.safeParse(value);
    if (!parsed.success || !params.mediaSourceRoot || !parsed.data.filePath) return;
    const localId = parsed.data.toolCallId
      ?? `cursor-generated-${createHash('sha256').update(parsed.data.filePath).digest('hex').slice(0, 32)}`;
    const entry = await acquireGeneratedMediaPublication(localId, async () => {
      const source = await params.context.services.sessions.current.media.registerSourceRoot({
        rootPath: params.mediaSourceRoot!,
      });
      try {
        await source.publishGenerated({
          localId,
          path: parsed.data.filePath!,
          referencePaths: parsed.data.referenceImagePaths,
          description: parsed.data.description,
          ...(parsed.data.toolCallId ? { toolCallId: parsed.data.toolCallId } : {}),
        });
      } finally {
        source.dispose();
      }
    }, extensionContext.signal);
    if (!entry) return;
    await entry.promise;
  };
  const generatedMediaRequest: AgentAcpRequestExtension = async (value, extensionContext) => {
    await generatedMediaNotification(value, extensionContext);
    return {};
  };

  return Object.freeze({
    askQuestion,
    createPlan,
    updateTodosRequest,
    updateTodosNotification,
    taskRequest,
    taskNotification,
    generatedMediaRequest,
    generatedMediaNotification,
  });
}
