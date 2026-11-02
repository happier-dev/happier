import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { routeClaudeAttachment } from './claudeAttachmentRouter';
import type { ClaudeGoalStatusTranscriptEvent } from '../workState/claudeGoalStatus';
import type { ClaudeQueuedCommandAttachment } from './claudeAttachmentTypes';

const GOAL_FIXTURE_DIR = join(__dirname, '../workState/__fixtures__/goal-status');

function readFixtureLine(name: string): unknown {
  const raw = readFileSync(join(GOAL_FIXTURE_DIR, name), 'utf8').trim().split('\n')[0];
  return JSON.parse(raw);
}

describe('routeClaudeAttachment', () => {
  it('routes provider-attested credential organizations with transcript chronology', () => {
    const events: unknown[] = [];
    routeClaudeAttachment({
      type: 'attachment', sessionId: 'native-session', timestamp: '2026-11-02T13:50:20.213Z',
      attachment: { type: 'credential_org', organizationUuid: 'org-failing' },
    }, { onCredentialOrganization: (event) => events.push(event) });
    expect(events).toEqual([{
      sourceSessionId: 'native-session', organizationId: 'org-failing', timestampMs: 1793627420213,
    }]);
  });
  it('routes a goal_status attachment to onGoalStatus with the parsed event', () => {
    const events: ClaudeGoalStatusTranscriptEvent[] = [];
    routeClaudeAttachment(readFixtureLine('edit-active.jsonl'), {
      onGoalStatus: (event) => events.push(event),
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.type).toBe('goal_status');
    expect(event.sourceSessionId).toBe('ff668493-8325-49cc-976f-689b779b85a2');
    expect(event.uuid).toBe('acde1bd2-f79f-43fb-8dd1-e2c8e2a0b294');
    expect(event.attachment.met).toBe(false);
    expect(event.attachment.condition).toBe('replace this goal with edited fixture objective');
  });

  it('still recognizes queued_command attachments', () => {
    const commands: ClaudeQueuedCommandAttachment[] = [];
    routeClaudeAttachment(
      {
        type: 'attachment',
        uuid: 'q1',
        sessionId: 's1',
        attachment: { type: 'queued_command', prompt: '/goal ship it' },
      },
      { onQueuedCommand: (command) => commands.push(command) },
    );

    expect(commands).toEqual([{ prompt: '/goal ship it' }]);
  });

  it('ignores unknown attachment types (forward-compatible)', () => {
    let goalCalls = 0;
    let queuedCalls = 0;
    const unknown: unknown[] = [];
    routeClaudeAttachment(
      { type: 'attachment', attachment: { type: 'agent_listing_delta', agents: [] } },
      {
        onGoalStatus: () => { goalCalls += 1; },
        onQueuedCommand: () => { queuedCalls += 1; },
        onUnknown: (record) => unknown.push(record),
      },
    );

    expect(goalCalls).toBe(0);
    expect(queuedCalls).toBe(0);
    expect(unknown).toHaveLength(1);
  });

  it('ignores non-attachment records and malformed envelopes', () => {
    let calls = 0;
    const handlers = { onGoalStatus: () => { calls += 1; }, onUnknown: () => { calls += 1; } };
    routeClaudeAttachment({ type: 'assistant', message: { content: [] } }, handlers);
    routeClaudeAttachment({ type: 'attachment' }, handlers);
    routeClaudeAttachment(null, handlers);
    routeClaudeAttachment({ type: 'attachment', attachment: { notype: true } }, handlers);
    expect(calls).toBe(0);
  });

  it('does not invoke onGoalStatus for a goal_status missing required fields', () => {
    let calls = 0;
    routeClaudeAttachment(
      // missing sessionId + condition
      { type: 'attachment', uuid: 'u1', attachment: { type: 'goal_status', met: false } },
      { onGoalStatus: () => { calls += 1; } },
    );
    expect(calls).toBe(0);
  });
});
