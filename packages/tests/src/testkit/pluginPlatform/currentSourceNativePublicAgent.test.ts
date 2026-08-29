import { describe, expect, it } from 'vitest';

import type {
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  QA_REFERENCE_CANDIDATE_ID,
  QA_REFERENCE_CONTEXT,
  QA_REFERENCE_LABEL,
  QA_REFERENCE_LOCAL_ID,
  createCurrentSourceQaAgentRuntime,
} from '../../../fixtures/plugin-platform/current-source-native-public/agent/deterministicAgent';
import { QA_REVISION } from '../../../fixtures/plugin-platform/current-source-native-public/revision';

/**
 * Diagnostic taxonomy for the shared current-source public fixture Agent.
 *
 * The canonical composer-facts admission tests (see
 * `currentManagedStackPluginUiQa.test.ts`) own the accept/reject event
 * contract. This file pins the stable `input-rejected` diagnostic codes so a
 * missing, stale, or wrong resolved fact is distinguishable at the Agent
 * runtime-event boundary instead of collapsing into one opaque rejection.
 */

const PLUGIN_ID = 'qa.current-source.native-public';
const OTHER_REVISION = QA_REVISION === 'v1' ? 'v2' : 'v1';

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function createContext(): AgentSessionRuntimeContext {
  // The fixture runtime reads only `plugin.id` and `session.id` from its
  // declared context; the remaining service bag is unused by this fixture and
  // deliberately absent here.
  return {
    plugin: { id: PLUGIN_ID, version: '0.0.1' },
    agent: { id: 'qa-agent' },
    session: { id: 'session-1' },
  } as unknown as AgentSessionRuntimeContext;
}

async function openSession(): Promise<AgentSessionRuntime> {
  const runtime = await createCurrentSourceQaAgentRuntime({
    plugin: { id: PLUGIN_ID, version: '0.0.1' },
    agent: { id: 'qa-agent' },
    signal: new AbortController().signal,
  });
  const sessions = runtime.sessions;
  if (!sessions) throw new Error('qa_agent_runtime_sessions_unavailable');
  return await sessions.open(
    { kind: 'create', sessionId: 'session-1', cwd: '/tmp' },
    createContext(),
  );
}

function collectEvents(session: AgentSessionRuntime): AgentSessionRuntimeEvent[] {
  const events: AgentSessionRuntimeEvent[] = [];
  session.watch((event) => { events.push(event); });
  return events;
}

function encodeModelText(value: string): string {
  // Mirrors the canonical composer reference context renderer exactly.
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

function exactComposerFactsPromptText(): string {
  return [
    `reference_plugin_id=${encodeModelText(PLUGIN_ID)}`,
    `reference_local_id=${encodeModelText(QA_REFERENCE_LOCAL_ID)}`,
    `candidate_id=${encodeModelText(QA_REFERENCE_CANDIDATE_ID)}`,
    `label=${encodeModelText(QA_REFERENCE_LABEL)}`,
    `context=${encodeModelText(QA_REFERENCE_CONTEXT)}`,
  ].join('\n');
}

function resolvedFacts(params: Readonly<{
  qaId?: string;
  attachmentLocalId?: string;
  omitResolved?: boolean;
  addForeignSibling?: boolean;
}> = {}): JsonValue {
  const envelope: { [key: string]: JsonValue } = { v: 1 };
  if (!params.omitResolved) {
    envelope.resolvedComposerAttachments = [
      {
        v: 1,
        instanceId: 'message-1#0',
        attachment: { pluginId: PLUGIN_ID, localId: params.attachmentLocalId ?? 'qa-item' },
        key: `qa-${params.qaId ?? QA_REVISION}`,
        value: { qaId: params.qaId ?? QA_REVISION },
        presentation: {
          label: `Current source QA attachment ${params.qaId ?? QA_REVISION}`,
          typeLabel: `Current source QA attachment ${params.qaId ?? QA_REVISION}`,
        },
        data: { qaId: params.qaId ?? QA_REVISION },
      },
      ...(params.addForeignSibling ? [{
        v: 1,
        instanceId: 'message-1#1',
        attachment: { pluginId: PLUGIN_ID, localId: 'qa-foreign' },
        key: `qa-${params.qaId ?? QA_REVISION}`,
        value: { qaId: params.qaId ?? QA_REVISION },
        presentation: { label: 'foreign', typeLabel: 'foreign' },
        data: { qaId: params.qaId ?? QA_REVISION },
      }] : []),
    ];
  }
  return envelope;
}

function sendRequest(params: Readonly<{
  structuredInput?: JsonValue | null;
  text?: string;
}>): Parameters<AgentSessionRuntime['send']>[0] {
  return {
    inputIds: ['input-1'],
    input: {
      text: params.text ?? exactComposerFactsPromptText(),
      ...(params.structuredInput === null
        ? {}
        : { structuredInput: params.structuredInput ?? resolvedFacts() }),
    },
    delivery: { kind: 'newTurn', turnId: 'turn-1' },
  };
}

function messageDeltaTexts(events: readonly AgentSessionRuntimeEvent[]): string[] {
  return events.flatMap((event) => (
    event.kind === 'message-delta' && event.channel === 'assistant' ? [event.text] : []
  ));
}

function inputRejectionCodes(events: readonly AgentSessionRuntimeEvent[]): string[] {
  return events.flatMap((event) => (
    event.kind === 'input-rejected' ? [event.diagnostic.code] : []
  ));
}

describe('current source native public fixture Agent admission diagnostics', () => {
  it('codes input without resolved Composer facts as missing', async () => {
    const session = await openSession();
    const events = collectEvents(session);

    await expect(session.send(sendRequest({ structuredInput: null }))).resolves.toMatchObject({
      status: 'rejected',
      retryable: false,
      diagnostic: { code: 'qa_input_facts_missing' },
    });

    expect(inputRejectionCodes(events)).toEqual(['qa_input_facts_missing']);
    expect(messageDeltaTexts(events)).not.toContain('PLUGIN_UI_CURRENT_SOURCE_NATIVE_ACCEPTED');
    await session.dispose();
  });

  it('codes resolved facts from another revision as stale', async () => {
    const session = await openSession();
    const events = collectEvents(session);

    await expect(session.send(sendRequest({ structuredInput: resolvedFacts({ qaId: OTHER_REVISION }) })))
      .resolves.toMatchObject({
        status: 'rejected',
        retryable: false,
        diagnostic: { code: 'qa_input_facts_stale' },
      });

    expect(inputRejectionCodes(events)).toEqual(['qa_input_facts_stale']);
    expect(messageDeltaTexts(events)).not.toContain('PLUGIN_UI_CURRENT_SOURCE_NATIVE_ACCEPTED');
    await session.dispose();
  });

  it('codes resolved facts bound to another contribution as wrong', async () => {
    const session = await openSession();
    const events = collectEvents(session);

    await expect(session.send(sendRequest({
      structuredInput: resolvedFacts({ attachmentLocalId: 'qa-something-else' }),
    }))).resolves.toMatchObject({
      status: 'rejected',
      retryable: false,
      diagnostic: { code: 'qa_input_facts_invalid' },
    });

    expect(inputRejectionCodes(events)).toEqual(['qa_input_facts_invalid']);
    expect(messageDeltaTexts(events)).not.toContain('PLUGIN_UI_CURRENT_SOURCE_NATIVE_ACCEPTED');
    await session.dispose();
  });

  it('codes an envelope with a foreign sibling attachment as wrong', async () => {
    const session = await openSession();
    const events = collectEvents(session);

    await expect(session.send(sendRequest({
      structuredInput: resolvedFacts({ addForeignSibling: true }),
    }))).resolves.toMatchObject({
      status: 'rejected',
      retryable: false,
      diagnostic: { code: 'qa_input_facts_invalid' },
    });

    expect(inputRejectionCodes(events)).toEqual(['qa_input_facts_invalid']);
    expect(messageDeltaTexts(events)).not.toContain('PLUGIN_UI_CURRENT_SOURCE_NATIVE_ACCEPTED');
    await session.dispose();
  });

  it('codes a missing resolved Composer reference context entry as wrong', async () => {
    const session = await openSession();
    const events = collectEvents(session);

    await expect(session.send(sendRequest({
      structuredInput: resolvedFacts(),
      text: 'plain text without the canonical composer reference context entry',
    }))).resolves.toMatchObject({
      status: 'rejected',
      retryable: false,
      diagnostic: { code: 'qa_input_facts_invalid' },
    });

    expect(inputRejectionCodes(events)).toEqual(['qa_input_facts_invalid']);
    expect(messageDeltaTexts(events)).not.toContain('PLUGIN_UI_CURRENT_SOURCE_NATIVE_ACCEPTED');
    await session.dispose();
  });
});
