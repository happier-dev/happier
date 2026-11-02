import { describe, expect, it, vi } from 'vitest';

import type { SessionWorkStateV1 } from '@happier-dev/protocol';
import type { JsonlFollowControllerOptions } from '@/agent/localControl/jsonlFollowController';

import { createClaudeGoalWorkStateSource } from './claudeGoalSource';
import {
  createClaudeGoalStatusTranscriptTail,
  isClaudeGoalStatusAttachmentValue,
} from './createClaudeGoalStatusTranscriptTail';

const SESSION_ID = 'claude-source-session';

function goalStatusAttachment(condition: string, met = false): unknown {
  return {
    type: 'attachment',
    uuid: `g-${condition}`,
    sessionId: SESSION_ID,
    timestamp: '2026-06-24T00:00:00.000Z',
    attachment: { type: 'goal_status', met, condition },
  };
}

/** A minimal fake of the jsonl follow primitive (the filesystem/watcher boundary). */
function fakeFollow() {
  const controllers: Array<{ opts: JsonlFollowControllerOptions; started: boolean; stopped: boolean }> = [];
  const createFollow = (opts: JsonlFollowControllerOptions) => {
    const controller = { opts, started: false, stopped: false };
    controllers.push(controller);
    return {
      async start() { controller.started = true; },
      async stop() { controller.stopped = true; },
    };
  };
  return {
    createFollow,
    latest: () => controllers.at(-1),
    controllers,
    emit: (value: unknown) => controllers.at(-1)?.opts.onJson(value),
  };
}

describe('isClaudeGoalStatusAttachmentValue', () => {
  it('matches only goal_status attachment records', () => {
    expect(isClaudeGoalStatusAttachmentValue(goalStatusAttachment('ship it'))).toBe(true);
    expect(isClaudeGoalStatusAttachmentValue({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: 'later' },
    })).toBe(false);
    expect(isClaudeGoalStatusAttachmentValue({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    })).toBe(false);
    expect(isClaudeGoalStatusAttachmentValue(null)).toBe(false);
    expect(isClaudeGoalStatusAttachmentValue('goal_status')).toBe(false);
  });
});

describe('createClaudeGoalStatusTranscriptTail', () => {
  it('shares its existing raw attachment channel with credential identity observations', async () => {
    const follow = fakeFollow();
    const observed: unknown[] = [];
    const tail = createClaudeGoalStatusTranscriptTail({
      onGoalStatusValue: () => {}, onRawTranscriptValue: (value) => observed.push(value),
      createFollow: follow.createFollow,
    });
    await tail.start('/tmp/claude-session.jsonl');
    const credential = { type: 'attachment', sessionId: SESSION_ID, timestamp: '2026-11-02T13:50:20.213Z',
      attachment: { type: 'credential_org', organizationUuid: 'org-current' } };
    follow.emit(credential);
    expect(observed).toEqual([credential]);
    await tail.stop();
  });
  function setup() {
    const published: SessionWorkStateV1[] = [];
    // publishWorkStateSnapshot is the metadata-write BOUNDARY; the goal source itself is real.
    const goalSource = createClaudeGoalWorkStateSource({
      backendId: 'claude',
      agentId: 'claude',
      publishWorkStateSnapshot: (snapshot) => published.push(snapshot),
      getCurrentClaudeSessionId: () => SESSION_ID,
    });
    const follow = fakeFollow();
    const tail = createClaudeGoalStatusTranscriptTail({
      onGoalStatusValue: (value) => goalSource.observeTranscriptMessage(value),
      createFollow: follow.createFollow,
    });
    return { published, follow, tail };
  }

  it('surfaces the goal work-state item from a goal_status value tailed off the transcript', async () => {
    const { published, follow, tail } = setup();
    await tail.start('/tmp/claude-session.jsonl');

    expect(follow.latest()?.started).toBe(true);
    follow.emit(goalStatusAttachment('ship the feature'));

    expect(published).toHaveLength(1);
    expect(published[0].items[0]).toMatchObject({
      id: 'goal:claude',
      kind: 'goal',
      status: 'active',
      title: 'ship the feature',
    });
  });

  it('forwards ONLY goal_status rows (ignores other transcript noise)', async () => {
    const { published, follow, tail } = setup();
    await tail.start('/tmp/claude-session.jsonl');

    follow.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    follow.emit({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'later' } });
    follow.emit({ type: 'system', subtype: 'init', slash_commands: ['goal'] });

    expect(published).toHaveLength(0);
  });

  it('starts at end-of-file and is idempotent for the same path', async () => {
    const { follow, tail } = setup();
    await tail.start('/tmp/claude-session.jsonl');
    await tail.start('/tmp/claude-session.jsonl');

    expect(follow.controllers).toHaveLength(1);
    // Unknown/nonexistent file -> startOffsetBytes falls back to 0 without throwing.
    expect(follow.latest()?.opts.startOffsetBytes).toBe(0);
  });

  it('re-targets to a new transcript path, stopping the previous follower', async () => {
    const { follow, tail } = setup();
    await tail.start('/tmp/first.jsonl');
    await tail.start('/tmp/second.jsonl');

    expect(follow.controllers).toHaveLength(2);
    expect(follow.controllers[0].stopped).toBe(true);
    expect(follow.controllers[1].started).toBe(true);
    expect(follow.controllers[1].opts.filePath).toBe('/tmp/second.jsonl');
  });

  it('ignores empty/blank paths', async () => {
    const { follow, tail } = setup();
    await tail.start(null);
    await tail.start('   ');
    expect(follow.controllers).toHaveLength(0);
  });

  it('stop() releases the active follower', async () => {
    const { follow, tail } = setup();
    await tail.start('/tmp/claude-session.jsonl');
    await tail.stop();
    expect(follow.latest()?.stopped).toBe(true);
  });
});
