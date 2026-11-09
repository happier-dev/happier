import { describe, expect, it } from 'vitest';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { prepareSessionInputForProviderDispatch } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { formatFileReviewNoteV1 } from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';

import {
  appendNextTurnContextToQueuedPrompt,
  combinePermissionModeQueuedPrompts,
  isNextTurnContextQueuedPrompt,
  normalizePermissionModeQueuedPromptLocalIds,
  type PermissionModeQueuedPrompt,
  type PermissionModeQueuedPromptMode,
} from './queuedPrompt';

describe('combinePermissionModeQueuedPrompts', () => {
  it.each(['Continue', '/native-command'])('preserves primary grammar and renders a review note only at dispatch (%s)', async primary => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => mode.permissionMode, {
      batcher: combinePermissionModeQueuedPrompts, isContextOnly: isNextTurnContextQueuedPrompt,
      withContext: appendNextTurnContextToQueuedPrompt,
    });
    const mode = { permissionMode: 'default' as const };
    queue.push({ text: 'Review facts', localId: 'note', fileReviewNote: { action: 'discard', paths: ['app.ts'] } }, mode);
    queue.push({ text: '/compact', localId: 'local-command' }, mode);
    const command = (await queue.waitForMessagesAndGetAsString())!.message;
    expect(parseSpecialCommand(command.text).type).toBe('compact');
    // Local command handling never dispatches or retires the retained note.
    expect(queue.getContextOnlyMessages().map(note => note.localId)).toEqual(['note']);
    queue.push({ text: primary, localId: 'actual' }, mode);
    const input = (await queue.waitForMessagesAndGetAsString())!.message;
    expect(input.text).toBe(primary);
    const prepared = await prepareSessionInputForProviderDispatch({ prompt: input, transformedUserText: input.text,
      providerNativeCommand: primary.startsWith('/'), signal: new AbortController().signal, localId: 'actual' });
    expect(prepared.renderPrompt()).toBe(primary.startsWith('/') ? primary
      : `${primary}\n\n<happier_review_note>${JSON.stringify({ text:
        'The person reviewing your work discarded your changes in "app.ts". Do not reapply them unless asked.',
      })}</happier_review_note>`);
    expect(queue.getContextOnlyMessages().map(note => note.localId)).toEqual(['note']);
    expect(input.localIds).toEqual(['actual']);
  });
  it('adds only newly joined file review note text when a composed input is requeued', async () => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => mode.permissionMode, {
      batcher: combinePermissionModeQueuedPrompts, isContextOnly: isNextTurnContextQueuedPrompt,
      withContext: appendNextTurnContextToQueuedPrompt,
    });
    const mode = { permissionMode: 'default' as const };
    const first: PermissionModeQueuedPrompt = { text: 'First review note', localId: 'note-1', userMessageSeq: 1,
      fileReviewNote: { action: 'discard', paths: ['one.ts'] } };
    const second: PermissionModeQueuedPrompt = { text: 'Second review note', localId: 'note-2', userMessageSeq: 2,
      fileReviewNote: { action: 'restore', paths: ['two.ts'] } };
    queue.push(first, mode);
    queue.push({ text: 'Continue', localId: 'actual', userMessageSeq: 3 }, mode);
    const composed = (await queue.waitForMessagesAndGetAsString())!.message;
    queue.push(second, mode);
    queue.push(composed, mode);
    const requeued = (await queue.waitForMessagesAndGetAsString())!.message;
    expect(requeued.text).toBe('Continue');
    const prepared = await prepareSessionInputForProviderDispatch({ prompt: requeued, transformedUserText: requeued.text,
      providerNativeCommand: false, signal: new AbortController().signal, localId: 'actual' });
    for (const item of [first, second]) {
      expect(prepared.renderPrompt().split(JSON.stringify({ text: formatFileReviewNoteV1(item.fileReviewNote!, 'agent') }))).toHaveLength(2);
    }
    expect(requeued.fileReviewNoteContext?.map(note => note.localId)).toEqual(['note-1', 'note-2']);
    expect(requeued.localIds).toEqual(['actual']);
    expect(requeued.userMessageSeqs).toEqual([3]);
  });
  it('retains a quiet returned answer without replacing the natural input native witness', async () => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => mode.permissionMode, {
      batcher: combinePermissionModeQueuedPrompts, isContextOnly: isNextTurnContextQueuedPrompt,
      withContext: appendNextTurnContextToQueuedPrompt,
    });
    const reply = { requestSessionId: 'requester', requestLocalId: 'question', outcome: 'answer' as const,
      delivery: 'next_turn' as const };
    queue.push({ text: 'The retained answer', localId: 'quiet-answer', userMessageSeq: 8, returnedAnswer: reply },
      { permissionMode: 'read-only' });
    expect(queue.size()).toBe(0);
    const authority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const };
    queue.push({ text: 'Continue', localId: 'natural-input', userMessageSeq: 9, causalPermissionAuthority: authority },
      { permissionMode: 'default' });
    const batch = await queue.waitForMessagesAndGetAsString();
    expect(batch?.message).toMatchObject({ localId: 'natural-input', localIds: ['natural-input'], userMessageSeq: 9,
      userMessageSeqs: [9], causalPermissionAuthority: authority,
      returnedAnswerContext: [{ reply, text: 'The retained answer', localId: 'quiet-answer', userMessageSeq: 8 }] });
  });

  it('does not merge distinct protected Discussion questions into one turn cutoff', () => {
    const discussionAddressing = { discussionId: 'discussion', messageId: 'first', throughSeq: 2, participantSessionId: 'receiver' };
    const prompt = { text: 'First question', localId: 'first-input', discussionAddressing };
    expect(combinePermissionModeQueuedPrompts([prompt])).toMatchObject({ discussionAddressing });
    expect(() => combinePermissionModeQueuedPrompts([prompt, { text: 'Second question', localId: 'second-input',
      discussionAddressing: { ...discussionAddressing, messageId: 'second', throughSeq: 3 } }])).toThrow();
  });
  it('retains the exact request cause and refuses to coalesce different requesters', () => {
    const bob = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' },
      persona: { serverId: 'home', sessionId: 'bot' }, origin: null };
    const prompt = { text: 'work', localId: 'bob-input', actionRequestAttributionV1: bob };
    expect(combinePermissionModeQueuedPrompts([prompt])).toMatchObject({ actionRequestAttributionV1: bob });
    expect(() => combinePermissionModeQueuedPrompts([prompt, {
      text: 'other work', localId: 'carol-input', actionRequestAttributionV1: {
        ...bob, requestRef: 'carol-input', requester: { serverId: 'home', accountId: 'carol' },
      },
    }])).toThrow();
  });

  it('joins prompt texts and keeps the first localId', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: 'b' },
    ]);
    expect(combined.text).toBe('one\ntwo');
    expect(combined.localId).toBe('a');
  });

  it('aggregates every localId in an ordinary non-Pending batch', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: 'b' },
      { text: 'again', localId: 'a' },
      { text: 'anonymous', localId: null },
    ]);

    expect(combined).toMatchObject({
      localId: 'a',
      localIds: ['a', 'b'],
    });
  });

  it('preserves whitespace-distinct opaque local ids for exact provider outcome correlation', () => {
    expect(normalizePermissionModeQueuedPromptLocalIds({
      text: 'opaque ids',
      localId: ' local-id ',
      localIds: ['local-id', ' local-id ', '   '],
    })).toEqual([' local-id ', 'local-id']);
  });

  it('carries exact committed user-message seqs for host-consumed command replay suppression', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a', userMessageSeq: 5 },
      { text: 'two', localId: 'b' },
      { text: 'three', localId: 'c', userMessageSeq: 9 },
    ]);
    expect(combined.userMessageSeq).toBe(9);
    expect(combined.userMessageSeqs).toEqual([5, 9]);
  });

  it('preserves the exact admitted authority when queue-key-compatible prompts batch', () => {
    const authority = {
      kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'read-only' as const,
      sourceAuthority: {
        kind: 'mediatedExternal' as const,
        mediatorPluginId: 'example.plugin',
        sourceRef: 'source-1',
        sourceRevisionOrEpoch: 'rev-1',
        admittedPermissionCeiling: 'read-only' as const,
        remoteApprovalMaxScope: 'request' as const,
      },
    };
    expect(combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a', causalPermissionAuthority: authority },
      { text: 'two', localId: 'b', causalPermissionAuthority: authority },
    ] as any)).toMatchObject({ causalPermissionAuthority: authority });
  });

  it('rejects an invalid batch containing multiple structured prompts instead of discarding later context', () => {
    expect(() => combinePermissionModeQueuedPrompts([
      {
        text: 'first structured prompt',
        localId: 'structured-1',
        structuredInput: {
          v: 1,
          skillMentions: [{ name: 'first', path: '/skills/first/SKILL.md' }],
        },
      },
      {
        text: 'second structured prompt',
        localId: 'structured-2',
        structuredInput: {
          v: 1,
          skillMentions: [{ name: 'second', path: '/skills/second/SKILL.md' }],
        },
      },
    ])).toThrow('Cannot combine multiple structured prompts');
  });

  it('leaves userMessageSeq unset when no prompt in the batch carries one', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: null },
    ]);
    expect(combined.userMessageSeq ?? null).toBeNull();
  });
});
