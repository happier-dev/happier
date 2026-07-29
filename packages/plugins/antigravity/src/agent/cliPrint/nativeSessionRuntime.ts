import type { AgentSessionRuntime } from '@happier-dev/plugin-sdk/agent-runtime';

import {
  type AntigravityConversationDiscovery,
  discoverNewAntigravityConversationId,
  resolveAntigravityBrainDir,
  resolveAntigravityTranscriptFullPath,
  snapshotAntigravityConversations,
} from './conversationStore.js';
import { createAntigravityCliPrintSessionRuntime } from './runtime.js';
import {
  runAntigravityCliPrintOneShot,
  type AntigravityCliPrintExecRun,
} from './oneShot.js';
import {
  readAntigravityTranscriptTail,
  type AntigravityTranscriptTailCursor,
} from './transcript/jsonl.js';
import { mapAntigravityTranscriptRecordsToSteps } from './transcript/mapper.js';
import { ANTIGRAVITY_AGENT_ID } from '../install/cliRuntime.js';
import { isolateAntigravityCliPrintEnv } from '../lifecycle/runtimeEnv.js';
import type { AntigravityStep } from '../normalize/index.js';
import { readAntigravitySessionMetadataRuntimeDescriptor } from '../runtime/runtimeDescriptor.js';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readStringRecord(value: unknown): Readonly<Record<string, string | undefined>> | null {
  const record = readRecord(value);
  if (!record) return null;
  const entries: Array<[string, string | undefined]> = [];
  for (const [key, rawValue] of Object.entries(record)) {
    if (typeof rawValue === 'string' || typeof rawValue === 'undefined') {
      entries.push([key, rawValue]);
    }
  }
  return Object.fromEntries(entries);
}

function readEnv(params: unknown): Readonly<Record<string, string | undefined>> {
  const record = readRecord(params);
  const isolation = readRecord(record?.isolation);
  return readStringRecord(isolation?.env) ?? readStringRecord(record?.env) ?? {};
}

function readCwd(params: unknown): string | null {
  const record = readRecord(params);
  return typeof record?.cwd === 'string'
    ? record.cwd
    : typeof record?.directory === 'string'
      ? record.directory
      : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readModelId(params: unknown): string | null {
  const record = readRecord(params);
  const modelId = readNonEmptyString(record?.modelId);
  return modelId && modelId !== 'default' ? modelId : null;
}

function readMetadata(params: unknown): Readonly<Record<string, unknown>> | null {
  return readRecord(readRecord(params)?.metadata);
}

export function createDefaultCliPrintSessionRuntime(params: Readonly<{
  sessionParams: Readonly<{
    sessionId: string;
    cwd: string;
    env?: Readonly<Record<string, string>>;
    modelId?: string | null;
    metadata?: Readonly<Record<string, unknown>>;
  }>;
  runAgentCli: AntigravityCliPrintExecRun;
}>): AgentSessionRuntime {
  const cwd = readCwd(params.sessionParams) ?? '.';
  const env = isolateAntigravityCliPrintEnv(readEnv(params.sessionParams));
  const brainDir = resolveAntigravityBrainDir(env);
  const runtimeDescriptor = readAntigravitySessionMetadataRuntimeDescriptor(
    readMetadata(params.sessionParams),
  );
  let lastDiscovery: AntigravityConversationDiscovery | null = null;

  const readTranscriptSteps = async (input: Readonly<{
    turnId?: string;
    conversationId?: string | null;
    cursor?: AntigravityTranscriptTailCursor;
  }>): Promise<readonly AntigravityStep[]> => {
    const conversationId = input.conversationId?.trim();
    if (!conversationId) return [];
    const transcriptPath = resolveAntigravityTranscriptFullPath(brainDir, conversationId);
    const tail = await readAntigravityTranscriptTail({
      path: transcriptPath,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return mapAntigravityTranscriptRecordsToSteps(tail.records, {
      ...(input.turnId ? { generatedIdNamespace: input.turnId } : {}),
    });
  };

  const readPromptMatchedConversation = async (input: Readonly<{
    discovery: Extract<AntigravityConversationDiscovery, { status: 'ambiguous' }>;
    prompt: string;
    turnId?: string;
  }>): Promise<Readonly<{
    conversationId: string;
    steps: readonly AntigravityStep[];
  }> | null> => {
    const prompt = input.prompt.trim();
    if (!prompt) return null;
    const matches: Array<Readonly<{
      conversationId: string;
      steps: readonly AntigravityStep[];
    }>> = [];
    for (const conversationId of input.discovery.candidates) {
      const steps = await readTranscriptSteps({
        conversationId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
      }).catch(() => []);
      if (steps.some((step) => step.kind === 'user_message' && step.text.trim() === prompt)) {
        matches.push({ conversationId, steps });
      }
    }
    return matches.length === 1 ? matches[0] ?? null : null;
  };

  return createAntigravityCliPrintSessionRuntime({
    sessionId: params.sessionParams.sessionId ?? 'antigravity-cliprint-session',
    cwd,
    executable: ANTIGRAVITY_AGENT_ID,
    ...(env ? { env } : {}),
    modelId: readModelId(params.sessionParams),
    sandbox: true,
    includeWorkspaceScope: true,
    conversationId: runtimeDescriptor?.agyConversationId ?? null,
    promptTimeoutMs: 120_000,
    discoverConversationId: async () => lastDiscovery ?? { status: 'not_found' },
    runOneShot: async (input) => {
      lastDiscovery = null;
      const beforeConversations = input.conversationId
        ? null
        : await snapshotAntigravityConversations(brainDir);
      const beforeTranscript = input.conversationId
        ? await readAntigravityTranscriptTail({
            path: resolveAntigravityTranscriptFullPath(brainDir, input.conversationId),
          })
        : null;
      return await runAntigravityCliPrintOneShot({
        agentId: ANTIGRAVITY_AGENT_ID,
        args: input.args,
        cwd: input.cwd,
        ...(input.env ? { env: input.env } : {}),
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        run: params.runAgentCli,
        readTranscriptSteps: async () => {
          const discoveredConversation = beforeConversations
            ? discoverNewAntigravityConversationId(
                beforeConversations,
                await snapshotAntigravityConversations(brainDir),
              )
            : { status: 'not_found' } satisfies AntigravityConversationDiscovery;
          lastDiscovery = discoveredConversation;
          if (!input.conversationId && discoveredConversation.status === 'ambiguous') {
            const match = await readPromptMatchedConversation({
              discovery: discoveredConversation,
              prompt: input.prompt,
              turnId: input.turnId,
            });
            if (match) {
              lastDiscovery = { status: 'found', conversationId: match.conversationId };
              return match.steps;
            }
          }
          const transcriptConversationId = input.conversationId
            ?? (discoveredConversation.status === 'found' ? discoveredConversation.conversationId : null);
          return await readTranscriptSteps({
            turnId: input.turnId,
            conversationId: transcriptConversationId,
            ...(beforeTranscript?.cursor ? { cursor: beforeTranscript.cursor } : {}),
          });
        },
      });
    },
  });
}
