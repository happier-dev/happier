import { renderDiscussionContextBlockV1, renderSessionInputContextPromptV1, type DiscussionPromptAuthorV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { WorkflowValueReference } from '@happier-dev/protocol/workflows';
import { MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES } from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { isWorkflowJsonObject, type WorkflowJsonValue } from './input';

export type WorkflowPromptContext = {
  author: DiscussionPromptAuthorV1;
  reference: WorkflowValueReference;
  token?: string;
  source?: WorkflowJsonValue;
  value: WorkflowJsonValue;
  incomplete?: true;
};

/** Source identities remain descriptive; reads still pass through their authorized Actions. */
export function projectWorkflowPromptContext(input: Readonly<{
  token?: string; reference: WorkflowValueReference; value: WorkflowJsonValue;
  resultSource?: Readonly<{ author: DiscussionPromptAuthorV1; source: WorkflowJsonValue;
    entries?: readonly Readonly<{ author: DiscussionPromptAuthorV1; source: WorkflowJsonValue; value: WorkflowJsonValue }>[] }>;
}>): WorkflowPromptContext[] {
  const { reference, value } = input;
  // The declared PR input is opaque forge data, even if its JSON happens to
  // resemble a Discussion or workflow result. Preserve the exact selected value.
  if (reference.kind === 'input' && reference.name === 'prUpdate') {
    return [{ reference, ...(input.token ? { token: input.token } : {}), value,
      author: { kind: 'person', displayName: 'Workflow input' } }];
  }
  if (reference.kind === 'result' && reference.path.length === 0 && input.resultSource?.entries) {
    return input.resultSource.entries.flatMap(entry => projectWorkflowPromptContext({ reference, value: entry.value,
      resultSource: { author: entry.author, source: entry.source } }));
  }
  if (isWorkflowJsonObject(value) && Array.isArray(value.outcomeReferences)) {
    const { outcomeReferences, context, nextParticipants: _nextParticipants, ...summary } = value;
    return [
      ...projectWorkflowPromptContext({ ...input, value: summary }),
      ...(isWorkflowJsonObject(context) ? projectWorkflowPromptContext({ ...input, value: context }) : []),
      ...outcomeReferences.map(outcome => {
        const row = isWorkflowJsonObject(outcome) ? outcome : {};
        const participant = isWorkflowJsonObject(row.participant) ? row.participant : {};
        const session = isWorkflowJsonObject(participant.session) ? participant.session : {};
        const { participant: _participant, ...content } = row;
        return { reference, author: { kind: participant.kind === 'model' ? 'model' as const : 'agent_session' as const,
          ...(typeof session.sessionId === 'string' ? { sessionId: session.sessionId } : {}),
          ...(typeof row.executionSessionId === 'string' ? { sessionId: row.executionSessionId } : {}) },
          source: { runId: row.runId ?? null, invocation: { recordId: row.invocationRecordId ?? null }, readAction: 'workflow.run.invocations.get' },
          value: content };
      }),
    ];
  }
  if (isWorkflowJsonObject(value) && Array.isArray(value.messages) && isWorkflowJsonObject(value.discussion)) {
    return value.messages.map(message => {
      const row = isWorkflowJsonObject(message) ? message : {};
      const producer = isWorkflowJsonObject(row.producerV1) ? row.producerV1 : undefined;
      return { reference, ...(input.token ? { token: input.token } : {}),
        author: { kind: producer ? 'agent_session' : 'person',
          ...(typeof row.authorAccountId === 'string' ? { accountId: row.authorAccountId } : {}),
          ...(typeof producer?.sessionId === 'string' ? { sessionId: producer.sessionId } : {}) },
        source: { discussion: value.discussion!, messageId: row.id ?? null, throughSeq: value.throughSeq ?? null,
          readAction: 'discussion.read' }, value: message };
    });
  }
  return [{ reference, ...(input.token ? { token: input.token } : {}), value,
    author: input.resultSource?.author ?? (reference.kind === 'result'
      ? { kind: 'agent_session', displayName: `Workflow result: ${reference.producer.blockId}` }
      : { kind: 'person', displayName: 'Workflow input' }),
    ...(input.resultSource ? { source: input.resultSource.source } : {}) }];
}

function serializeWorkflowPromptContextEntry({ author, ...entry }: WorkflowPromptContext) {
  return { author, text: JSON.stringify(entry) };
}

export function renderWorkflowPromptContext(entries: readonly WorkflowPromptContext[]): string {
  const forgeEntries: WorkflowPromptContext[] = [];
  const discussionEntries: WorkflowPromptContext[] = [];
  for (const entry of entries) {
    (entry.reference.kind === 'input' && entry.reference.name === 'prUpdate' ? forgeEntries : discussionEntries).push(entry);
  }
  if (forgeEntries.length > 0) {
    return renderSessionInputContextPromptV1({
      transformedUserText: '',
      discussionContext: discussionEntries.map(serializeWorkflowPromptContextEntry),
      forgeEvidence: { v: 1, items: forgeEntries.map(entry => ({
        source: { kind: 'pullRequest', label: 'Pull request workflow input' },
        author: { kind: 'unknown' },
        text: serializeWorkflowPromptContextEntry(entry).text,
      })) },
    });
  }
  return renderDiscussionContextBlockV1(entries.map(serializeWorkflowPromptContextEntry));
}

/** Reduce only the prompt projection. Exact values and source custody remain at their existing owners. */
export function compactWorkflowPromptContext(entries: WorkflowPromptContext[], render: () => string, rendered: string): string | null {
  // Preserve the original question/request and the newest Discussion item. Older
  // messages become source references before any individual body is shortened.
  const discussionEntries = entries.filter(entry => isWorkflowJsonObject(entry.source) && entry.source.readAction === 'discussion.read');
  const older = discussionEntries.slice(0, -1).filter(entry => !entry.incomplete);
  if (older.length > 0) {
    let bytes = Buffer.byteLength(rendered, 'utf8');
    for (const entry of older) {
      // The canonical writer frames entries independently, so this delta is
      // exact. Marking a tiny value incomplete can grow it: keep authored order
      // and stop at the first fit instead of assuming monotonic prefix sizes.
      const originalBytes = Buffer.byteLength(renderWorkflowPromptContext([entry]), 'utf8');
      entry.value = null;
      entry.incomplete = true;
      bytes += Buffer.byteLength(renderWorkflowPromptContext([entry]), 'utf8') - originalBytes;
      if (bytes <= MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES) break;
    }
    return render();
  }
  const candidates = entries.filter(entry => !(entry.reference.kind === 'input'
    && (entry.reference.name === 'question' || entry.reference.name === 'request')));
  const largest = candidates.map(entry => ({ entry, text: typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value) }))
    .filter(candidate => candidate.text.length > 1 && candidate.entry.value !== null)
    .sort((left, right) => right.text.length - left.text.length)[0];
  if (!largest) return null;
  // Repeated halving is logarithmic and uses the containing materialization
  // allowance; this introduces no second budget or per-source limit.
  largest.entry.value = largest.text.slice(-Math.floor(largest.text.length / 2));
  largest.entry.incomplete = true;
  return render();
}
