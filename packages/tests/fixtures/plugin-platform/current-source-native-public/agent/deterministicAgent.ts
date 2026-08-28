import type {
  AgentRuntimeFactory,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { QA_REVISION } from '../revision.js';

type RuntimeEventInput = AgentSessionRuntimeEvent extends infer Event
  ? Event extends AgentSessionRuntimeEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never
  : never;

type JsonRecord = { [key: string]: unknown };

const ATTACHMENT_LOCAL_ID = 'qa-item';
const REFERENCE_LOCAL_ID = 'qa-references';
const REFERENCE_CANDIDATE_ID = 'qa:1';
const REFERENCE_LABEL = 'Current source QA reference';
const REFERENCE_CONTEXT = 'Current source native QA reference context.';
const TRANSCRIPT_SENTINEL = 'PLUGIN_UI_CURRENT_SOURCE_NATIVE_ACCEPTED';

/**
 * Stable admission diagnostics for the runtime-event boundary. They let a QA
 * reader distinguish a turn that carried no resolved Composer facts from one
 * carrying another generation's facts or structurally wrong facts.
 */
const DIAGNOSTIC_CODES = {
  missing: 'qa_input_facts_missing',
  stale: 'qa_input_facts_stale',
  invalid: 'qa_input_facts_invalid',
} as const;

function asRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The revision a facts record stamps: exactly `{ qaId: <revision> }`, else
 * `null` (a shape violation, which classifies as wrong rather than stale).
 */
function revisionOfFacts(value: unknown): string | null {
  if (!asRecord(value) || Object.keys(value).length !== 1 || typeof value.qaId !== 'string') return null;
  return value.qaId;
}

function revisionOfKey(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('qa-')) return null;
  return value.slice(3);
}

/**
 * The exact model-visible Composer reference context entry the canonical
 * dispatch owner renders for this fixture's resolved reference. The values
 * carry no `<`/`>`, so the canonical JSON escaping is plain `JSON.stringify`.
 */
function expectedReferenceContextLines(pluginId: string): readonly string[] {
  const encode = (value: string): string => JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
  return [
    `reference_plugin_id=${encode(pluginId)}`,
    `reference_local_id=${encode(REFERENCE_LOCAL_ID)}`,
    `candidate_id=${encode(REFERENCE_CANDIDATE_ID)}`,
    `label=${encode(REFERENCE_LABEL)}`,
    `context=${encode(REFERENCE_CONTEXT)}`,
  ];
}

/**
 * The fixture Agent only settles a turn after the exact revision-qualified
 * resolved Composer facts have been observed at this boundary:
 *
 * 1. `request.input.structuredInput` must carry exactly one resolved
 *    Composer attachment bound to this plugin's `qa-item` contribution whose
 *    key, value and resolved data all carry this generation's revision.
 * 2. `request.input.text` must carry the canonical Composer reference context
 *    entry rendered by the dispatch owner for this fixture's resolved
 *    `qa-references` reference, proving the reference was resolved through
 *    the one host resolution path rather than assumed.
 */
function validateQaInputFacts(params: Readonly<{
  pluginId: string;
  input: Readonly<{ text: string; structuredInput?: unknown }>;
}>): { code: (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES]; message: string } | null {
  const structuredInput = params.input.structuredInput;
  if (!asRecord(structuredInput) || structuredInput.v !== 1) {
    return {
      code: DIAGNOSTIC_CODES.missing,
      message: 'The QA Agent requires a v1 structured input envelope with resolved Composer facts.',
    };
  }
  const resolved = structuredInput.resolvedComposerAttachments;
  if (!Array.isArray(resolved) || resolved.length === 0) {
    return {
      code: DIAGNOSTIC_CODES.missing,
      message: 'The QA Agent requires exactly one resolved Composer attachment.',
    };
  }
  if (resolved.length > 1) {
    return {
      code: DIAGNOSTIC_CODES.invalid,
      message: 'The QA Agent accepts exactly one resolved Composer attachment; the envelope carries extras.',
    };
  }
  const entry = resolved[0];
  if (!asRecord(entry)) {
    return { code: DIAGNOSTIC_CODES.invalid, message: 'The resolved Composer attachment record is malformed.' };
  }
  const attachment = entry.attachment;
  if (!asRecord(attachment) || attachment.pluginId !== params.pluginId || attachment.localId !== ATTACHMENT_LOCAL_ID) {
    return {
      code: DIAGNOSTIC_CODES.invalid,
      message: `The resolved Composer attachment must reference this plugin's ${ATTACHMENT_LOCAL_ID} contribution.`,
    };
  }
  if (typeof entry.instanceId !== 'string' || !asRecord(entry.presentation)) {
    return { code: DIAGNOSTIC_CODES.invalid, message: 'The resolved Composer attachment record is malformed.' };
  }
  const keyRevision = revisionOfKey(entry.key);
  const valueRevision = revisionOfFacts(entry.value);
  const dataRevision = revisionOfFacts(entry.data);
  if (keyRevision === null || valueRevision === null || dataRevision === null) {
    return {
      code: DIAGNOSTIC_CODES.invalid,
      message: 'The resolved Composer attachment facts are malformed.',
    };
  }
  if (keyRevision !== QA_REVISION || valueRevision !== QA_REVISION || dataRevision !== QA_REVISION) {
    return {
      code: DIAGNOSTIC_CODES.stale,
      message: `The resolved Composer facts belong to another fixture generation, not ${QA_REVISION}.`,
    };
  }
  for (const line of expectedReferenceContextLines(params.pluginId)) {
    if (!params.input.text.includes(line)) {
      return {
        code: DIAGNOSTIC_CODES.invalid,
        message: 'The QA Agent requires the resolved Composer reference context entry in the turn text.',
      };
    }
  }
  return null;
}

function createSessionRuntime(context: AgentSessionRuntimeContext): AgentSessionRuntime {
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  let sequence = 0;
  let disposed = false;
  const emit = (event: RuntimeEventInput) => {
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      sessionId: context.session.id,
      emittedAtMs: Date.now(),
    }) as AgentSessionRuntimeEvent;
    for (const listener of listeners) listener(published);
  };
  return {
    runtimeCapabilities: {
      sessionCapabilities: {
        sessionListing: 'unsupported',
        sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
        sessionRollback: { conversation: 'unsupported' },
      },
    },
    async send(request) {
      if (disposed) {
        return {
          status: 'unavailable',
          retryable: false,
          diagnostic: { code: 'qa_agent_disposed', severity: 'error', message: 'The QA Agent is disposed.' },
        };
      }
      if (request.delivery.kind !== 'newTurn') {
        const diagnostic = { code: 'qa_delivery_unsupported', severity: 'error' as const, message: 'Only a new turn is supported.' };
        emit({ kind: 'input-rejected', inputIds: request.inputIds, diagnostic, retryable: false });
        return { status: 'unsupported', diagnostic, retryable: false };
      }
      const violation = validateQaInputFacts({
        pluginId: context.plugin.id,
        input: request.input,
      });
      if (violation) {
        const diagnostic = { code: violation.code, severity: 'error' as const, message: violation.message };
        emit({ kind: 'input-rejected', inputIds: request.inputIds, diagnostic, retryable: false });
        return { status: 'rejected', diagnostic, retryable: false };
      }
      emit({ kind: 'provider-session-id', providerSessionId: `current-source:${context.session.id}` });
      emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
      emit({ kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
      emit({
        kind: 'message-delta',
        turnId: request.delivery.turnId,
        channel: 'assistant',
        text: TRANSCRIPT_SENTINEL,
      });
      emit({ kind: 'turn-complete', turnId: request.delivery.turnId });
      return { status: 'admitted' };
    },
    async cancel() { return { status: 'notRunning' }; },
    watch(listener) {
      if (!disposed) listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

export const createCurrentSourceQaAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    async open(_request, context) {
      return createSessionRuntime(context);
    },
  },
});
