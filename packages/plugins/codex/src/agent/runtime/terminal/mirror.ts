import type {
  TerminalRuntimeDirectTranscriptMirrorHandleV1,
  TerminalRuntimeLaunchRequestV1,
} from '@happier-dev/plugin-sdk';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/plugin-sdk/sessions';

import type { CodexRolloutCandidate } from '../../rollout/discovery/indexData.js';
import { sendCodexProjectedToolEvent } from '../core/projectedToolEvent.js';
import {
  normalizeCodexTerminalSessionId,
  type CodexTerminalEnv,
} from './invocation.js';
import { createCodexTerminalRuntimeProjection } from './projection.js';
import { resolveCodexTerminalRuntimeTranscriptBinding } from './transcriptBinding.js';

const MISSING_PROVIDER_TRANSCRIPT_ITEM_ID_DIAGNOSTIC_ID = 'codex-terminal-direct-transcript:item-skipped:missing-id';
const MISSING_PROVIDER_TRANSCRIPT_ITEM_ID_EVENT_KIND = 'codex-terminal-direct-transcript-item-skipped';

type CodexTerminalDirectTranscriptMirrorDiagnostics = {
  missingProviderTranscriptItemId: boolean;
};

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readActiveServerDir(request: TerminalRuntimeLaunchRequestV1): string {
  return readString(request.metadata.activeServerDir)
    ?? readString(readRecord(request.metadata.terminalRuntime)?.activeServerDir)
    ?? request.directory;
}

function readCodexRawData(item: ExternalSessionTranscriptRawMessageV1): Readonly<Record<string, unknown>> | null {
  const raw = readRecord(item.raw);
  if (!raw || raw.role !== 'agent') {
    return null;
  }
  const content = readRecord(raw.content);
  if (!content || content.type !== 'codex') {
    return null;
  }
  return readRecord(content.data);
}

async function publishMissingProviderTranscriptItemIdDiagnostic(params: Readonly<{
  request: TerminalRuntimeLaunchRequestV1;
  diagnostics: CodexTerminalDirectTranscriptMirrorDiagnostics;
}>): Promise<void> {
  if (params.diagnostics.missingProviderTranscriptItemId) {
    return;
  }
  params.diagnostics.missingProviderTranscriptItemId = true;
  await params.request.services?.send({
    kind: 'sessionEvent',
    event: {
      kind: MISSING_PROVIDER_TRANSCRIPT_ITEM_ID_EVENT_KIND,
      reason: 'missing_provider_transcript_item_id',
      agentId: 'codex',
    },
    id: MISSING_PROVIDER_TRANSCRIPT_ITEM_ID_DIAGNOSTIC_ID,
  }).catch(() => ({ ok: false as const, error: 'publish_failed' }));
}

async function handleDirectTranscriptItem(params: Readonly<{
  item: ExternalSessionTranscriptRawMessageV1;
  request: TerminalRuntimeLaunchRequestV1;
  processedItemIds: Set<string>;
  diagnostics: CodexTerminalDirectTranscriptMirrorDiagnostics;
  mirror: ReturnType<typeof createCodexTerminalRuntimeProjection>;
}>): Promise<void> {
  const stableItemId = readString(params.item.id);
  if (!stableItemId) {
    await publishMissingProviderTranscriptItemIdDiagnostic({
      request: params.request,
      diagnostics: params.diagnostics,
    });
    return;
  }
  if (params.processedItemIds.has(stableItemId)) {
    return;
  }
  params.processedItemIds.add(stableItemId);

  const raw = readRecord(params.item.raw);
  if (!raw) {
    return;
  }
  if (raw.role === 'user') {
    const content = readRecord(raw.content);
    const text = content?.type === 'text' ? readString(content.text) : null;
    if (!text) {
      return;
    }
    await params.request.services?.send({
      kind: 'userText',
      text,
      opts: {
        localId: stableItemId,
        meta: {
          importedFrom: 'codex-terminal-direct-transcript',
          providerTranscriptItemId: stableItemId,
        },
      },
    });
    return;
  }

  const data = readCodexRawData(params.item);
  if (!data) {
    return;
  }
  const sidechainId = readString(data.sidechainId);
  if (data.type === 'message') {
    const message = readString(data.message);
    if (!message) {
      return;
    }
    await params.request.services?.send({
      kind: 'agentMessageCommitted',
      agentId: 'codex',
      body: {
        type: 'message',
        message,
        id: stableItemId,
        ...(sidechainId ? { sidechainId } : {}),
      },
      opts: {
        localId: stableItemId,
      },
    });
    return;
  }

  if (data.type === 'tool-call') {
    const callId = readString(data.callId);
    const name = readString(data.name);
    if (!callId || !name) {
      return;
    }
    if (!sidechainId && name === 'SubAgent') {
      const input = readRecord(data.input);
      await params.mirror.publishSubagentStarted({
        threadId: callId,
        prompt: readString(input?.prompt),
        nickname: readString(input?.nickname),
        role: readString(input?.role),
      });
      return;
    }
    await sendCodexProjectedToolEvent({
      session: {
        sendAgentMessage: async (_agentId, body) => {
          await params.request.services?.send({
            kind: 'agentMessageCommitted',
            agentId: 'codex',
            body,
            opts: {
              localId: body.id,
            },
          });
        },
        sendProviderMessage: async ({ body }) => {
          await params.request.services?.send({
            kind: 'providerDispatch',
            body,
          });
        },
      },
      event: {
        type: 'tool-call',
        callId,
        name,
        input: data.input,
        sidechainId,
      },
      messageId: stableItemId,
    });
    return;
  }

  if (data.type === 'tool-call-result') {
    const callId = readString(data.callId);
    if (!callId) {
      return;
    }
    const output = data.output;
    const outputRecord = readRecord(output);
    const status = readString(outputRecord?.status);
    if (!sidechainId && (status === 'completed' || status === 'interrupted')) {
      await params.mirror.publishSubagentCompleted({
        threadId: callId,
        status,
        summaryText: readString(outputRecord?.summaryText),
      });
      return;
    }
    await sendCodexProjectedToolEvent({
      session: {
        sendAgentMessage: async (_agentId, body) => {
          await params.request.services?.send({
            kind: 'agentMessageCommitted',
            agentId: 'codex',
            body,
            opts: {
              localId: body.id,
            },
          });
        },
        sendProviderMessage: async ({ body }) => {
          await params.request.services?.send({
            kind: 'providerDispatch',
            body,
          });
        },
      },
      event: {
        type: 'tool-result',
        callId,
        output,
        sidechainId,
        ...(data.isError === true ? { isError: true } : {}),
      },
      messageId: stableItemId,
    });
  }
}

export async function openCodexTerminalDirectTranscriptMirror(params: Readonly<{
  candidate: CodexRolloutCandidate;
  request: TerminalRuntimeLaunchRequestV1;
  childEnv: CodexTerminalEnv;
  codexHome: string;
  resumeId: string | null;
}>): Promise<TerminalRuntimeDirectTranscriptMirrorHandleV1 | null> {
  const hostProjection = params.request.host?.projection;
  if (!hostProjection) {
    return null;
  }
  const projection = createCodexTerminalRuntimeProjection({ projection: hostProjection });
  const providerSessionId = normalizeCodexTerminalSessionId(params.candidate.sessionMeta.id)
    ?? params.resumeId;
  await projection.publishCodexSessionId(providerSessionId);
  const binding = resolveCodexTerminalRuntimeTranscriptBinding({
    activeServerDir: readActiveServerDir(params.request),
    candidateFilePath: params.candidate.filePath,
    codexHome: params.codexHome,
    remoteSessionId: providerSessionId,
    sessionMetaId: normalizeCodexTerminalSessionId(params.candidate.sessionMeta.id),
    env: params.childEnv as NodeJS.ProcessEnv,
  });
  if (!binding) {
    return null;
  }
  const processedItemIds = new Set<string>();
  const diagnostics: CodexTerminalDirectTranscriptMirrorDiagnostics = {
    missingProviderTranscriptItemId: false,
  };
  return await projection.openDirectTranscriptMirror({
    binding: {
      agentId: binding.agentId,
      source: binding.source,
      remoteSessionId: binding.remoteSessionId,
    },
    onItems: async (items) => {
      for (const item of items) {
        await handleDirectTranscriptItem({
          item,
          request: params.request,
          processedItemIds,
          diagnostics,
          mirror: projection,
        });
      }
    },
  });
}
