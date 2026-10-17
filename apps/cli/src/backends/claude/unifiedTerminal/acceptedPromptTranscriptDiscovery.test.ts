import { describe, expect, it } from 'vitest';

import { GENERIC_CONTINUATION_RESUME_PROMPT } from '@/daemon/connectedServices/continuation/continuationResumePrompt';
import type { RawJSONLines } from '../types';
import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import { createClaudeUnifiedHookLifecycleBridge } from './createClaudeUnifiedHookLifecycleBridge';
import { doesClaudeUnifiedPromptBatchMatchAcceptedTranscript } from './acceptedPromptDeliveryIdentity';
import { createClaudeUnifiedAcceptedPromptTranscriptDiscovery } from './acceptedPromptTranscriptDiscovery';

describe('createClaudeUnifiedAcceptedPromptTranscriptDiscovery', () => {
  // Claude Code 2.1.302, isolated native probe with respondToBashCommands:false:
  // caveat -> bash input -> bash output share promptId and link through parentUuid.
  function shellRows(command = ' echo hi') {
    const common = { type: 'user', promptId: 'shell-prompt', sessionId: 'shell-session', timestamp: new Date(2_050).toISOString() } as const;
    return {
      caveat: { ...common, uuid: 'shell-caveat', isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>The command output goes directly to the user.</local-command-caveat>' } } satisfies RawJSONLines,
      input: { ...common, uuid: 'shell-input', parentUuid: 'shell-caveat',
        message: { role: 'user', content: `<bash-input>${command}</bash-input>` } } satisfies RawJSONLines,
      output: { ...common, uuid: 'shell-output', parentUuid: 'shell-input',
        message: { role: 'user', content: '<bash-stdout>hi\n</bash-stdout><bash-stderr></bash-stderr>' } } satisfies RawJSONLines,
    };
  }

  it.each([' echo hi', 'echo hi'])('accepts exact native bash input and completes a local command once (%j)', (command) => {
    const completed: string[] = [];
    const consumed: RawJSONLines[] = [];
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000, nowMs: () => 2_000,
      onControlCommandConsumed: (message) => { consumed.push(message); },
      onAttemptLocalCommandCompleted: ({ acceptedPromptId }) => { completed.push(acceptedPromptId); },
    });
    const id = discovery.recordAcceptedPrompt({ message: `!${command}`, deliveryIdentity: { localIds: ['shell-local-id'] } });
    const rows = shellRows(command);
    discovery.observeControlCommandTranscript(rows.caveat);
    discovery.observeControlCommandTranscript(rows.input);
    discovery.observeControlCommandTranscript(rows.output);
    expect(completed).toEqual([]);
    const match = discovery.findMatchingTranscript([rows.input]);
    expect(match).toMatchObject({ acceptedPromptId: id, deliveryIdentity: { localIds: ['shell-local-id'] } });
    expect(match && discovery.consumeAcceptedPromptMatch(match)).toBe(true);
    expect(completed).toEqual([id]);
    discovery.observeControlCommandTranscript(rows.output);
    expect(completed).toEqual([id]);
    expect(discovery.findMatchingTranscript([rows.input])).toBeNull();
    expect(consumed).not.toContain(rows.input);
    expect(consumed).not.toContain(rows.output);
  });

  it.each(['inference', 'unrelated_caveat', 'sidechain_caveat', 'peer_caveat'] as const)(
    'keeps shell completion on provider lifecycle without its own main-chain caveat (%s)', (scenario) => {
      const completed: string[] = [];
      const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
        acceptedPromptWindowMs: 5_000, nowMs: () => 2_000,
        onAttemptLocalCommandCompleted: ({ acceptedPromptId }) => { completed.push(acceptedPromptId); },
      });
      discovery.recordAcceptedPrompt({ message: '! echo hi', deliveryIdentity: { localIds: ['shell-local-id'] } });
      const rows = shellRows();
      if (scenario === 'unrelated_caveat') discovery.observeControlCommandTranscript({ ...rows.caveat, uuid: 'another-command-caveat' });
      if (scenario === 'sidechain_caveat') discovery.observeControlCommandTranscript({ ...rows.caveat, isSidechain: true });
      if (scenario === 'peer_caveat') discovery.observeControlCommandTranscript({ ...rows.caveat, origin: { kind: 'peer' } });
      const match = discovery.findMatchingTranscript([rows.input]);
      expect(match).not.toBeNull();
      expect(match && discovery.consumeAcceptedPromptMatch(match)).toBe(true);
      discovery.observeControlCommandTranscript(rows.output);
      expect(completed).toEqual([]);
    },
  );

  it.each(['sidechain', 'peer'] as const)('rejects foreign bash input as primary delivery evidence (%s)', (origin) => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({ acceptedPromptWindowMs: 5_000, nowMs: () => 2_000 });
    discovery.recordAcceptedPrompt({ message: '! echo hi', deliveryIdentity: { localIds: ['shell-local-id'] } });
    const rows = shellRows();
    const input = origin === 'sidechain' ? { ...rows.input, isSidechain: true } : { ...rows.input, origin: { kind: 'peer' } };
    expect(discovery.observeControlCommandTranscript(input)).toBe(false);
    expect(discovery.findMatchingTranscript([input])).toBeNull();
  });

  it('does not accept a meta shell row as human delivery evidence', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({ acceptedPromptWindowMs: 5_000, nowMs: () => 2_000 });
    discovery.recordAcceptedPrompt({ message: '! echo hi', deliveryIdentity: { localIds: ['shell-local-id'] } });
    expect(discovery.findMatchingTranscript([{ ...shellRows().input, isMeta: true }])).toBeNull();
  });

  it.each(['unrelated_parent', 'sidechain', 'peer'] as const)('does not let foreign shell output complete a local attempt (%s)', (origin) => {
    const completed: string[] = [];
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000, nowMs: () => 2_000,
      onAttemptLocalCommandCompleted: ({ acceptedPromptId }) => { completed.push(acceptedPromptId); },
    });
    discovery.recordAcceptedPrompt({ message: '! echo hi', deliveryIdentity: { localIds: ['shell-local-id'] } });
    const rows = shellRows();
    discovery.observeControlCommandTranscript(rows.caveat);
    const match = discovery.findMatchingTranscript([rows.input]);
    expect(match && discovery.consumeAcceptedPromptMatch(match)).toBe(true);
    const output = origin === 'unrelated_parent' ? { ...rows.output, parentUuid: 'another-shell-input' }
      : origin === 'sidechain' ? { ...rows.output, isSidechain: true }
        : { ...rows.output, origin: { kind: 'peer' } };
    discovery.observeControlCommandTranscript(output);
    expect(completed).toEqual([]);
  });

  it.each(['early_output', 'long_output_before_acceptance', 'long_output_after_acceptance'] as const)(
    'settles shell delivery and allows the following prompt after %s', async (timing) => {
    let nowMs = 2_000;
    const injected: string[] = [];
    const accepted: string[] = [];
    let completed = 0;
    let completion: Promise<void> | undefined;
    let bridge: ReturnType<typeof createClaudeUnifiedHookLifecycleBridge> | undefined;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000, nowMs: () => nowMs,
      onAttemptLocalCommandCompleted: () => { completion = bridge?.settleAttemptLocalCommandCompleted(); return completion; },
    });
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs, quietPeriodMs: 0,
      injectPrompt: async (batch) => {
        injected.push(batch.message);
        if (batch.message === '! echo hi') {
          // File-follow evidence may precede completion of the terminal write.
          const rows = shellRows();
          discovery.observeControlCommandTranscript(rows.caveat);
          discovery.observeControlCommandTranscript(rows.input);
          if (timing === 'early_output') discovery.observeControlCommandTranscript(rows.output);
        }
        return { status: 'injected', at: 2_000, bytesWritten: batch.message.length };
      },
      onProviderAcceptancePending: (batch) => { discovery.recordAcceptedPrompt({ message: batch.message,
        deliveryIdentity: { localIds: batch.userMessageLocalIds ?? [] } }); },
      onPromptAccepted: (batch) => {
        discovery.consumeAcceptedPromptByBatch(batch);
        accepted.push(...(batch.userMessageLocalIds ?? []));
      },
    });
    bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: () => () => undefined,
      arbiter, completionQuiescenceMs: 0,
      onReady: () => { completed += 1; },
    });
    try {
      arbiter.observeLifecycle({ type: 'output', observedAtMs: 2_000 });
      await arbiter.enqueueUiMessage({ message: '! echo hi', origin: { kind: 'ui_pending' }, userMessageLocalIds: ['shell-local-id'] });
      await arbiter.drainWhenSafe();
      await arbiter.enqueueUiMessage({ message: 'ordinary next prompt', origin: { kind: 'ui_pending' }, userMessageLocalIds: ['next-local-id'] });
      await arbiter.drainWhenSafe();
      expect(injected).toEqual(['! echo hi']);
      const rows = shellRows();
      discovery.observeControlCommandTranscript(rows.caveat);
      discovery.observeControlCommandTranscript(rows.input);
      if (timing === 'long_output_before_acceptance') {
        nowMs = 90_000;
        discovery.observeControlCommandTranscript({ ...rows.output, timestamp: new Date(nowMs).toISOString() });
      }
      const match = discovery.findMatchingTranscript([rows.input]);
      expect(match).not.toBeNull();
      expect(await arbiter.confirmPromptAcceptedByProviderIf((batch) => Boolean(match && doesClaudeUnifiedPromptBatchMatchAcceptedTranscript({ batch, match })))).toBe(true);
      if (timing === 'long_output_after_acceptance') nowMs = 90_000;
      const output = { ...rows.output, timestamp: new Date(nowMs).toISOString() };
      discovery.observeControlCommandTranscript(output);
      discovery.observeControlCommandTranscript(output);
      await completion;
      await arbiter.drainWhenSafe();
      expect(accepted).toEqual(['shell-local-id']);
      expect(completed).toBe(1);
      expect(injected).toEqual(['! echo hi', 'ordinary next prompt']);
    } finally {
      bridge.dispose();
      await arbiter.dispose();
    }
  });

  it.each(['before_output', 'after_output'] as const)('retains a long-running local slash command accepted %s', (acceptanceTiming) => {
    let nowMs = 2_000;
    const completed: string[] = [];
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000, nowMs: () => nowMs,
      onAttemptLocalCommandCompleted: ({ acceptedPromptId }) => { completed.push(acceptedPromptId); },
    });
    const id = discovery.recordAcceptedPrompt({ message: '/model opus', deliveryIdentity: { localIds: ['long-model'] } });
    const command = { type: 'user', uuid: 'long-model-command', timestamp: new Date(nowMs).toISOString(),
      message: { role: 'user', content: '<command-name>/model</command-name><command-args>opus</command-args>' } } satisfies RawJSONLines;
    const match = discovery.findMatchingTranscript([command]);
    expect(match).not.toBeNull();
    if (acceptanceTiming === 'before_output') expect(match && discovery.consumeAcceptedPromptMatch(match)).toBe(true);
    nowMs = 90_000;
    const output = { type: 'user', uuid: 'long-model-output', parentUuid: command.uuid, timestamp: new Date(nowMs).toISOString(),
      message: { role: 'user', content: '<local-command-stdout>Model updated</local-command-stdout>' } } satisfies RawJSONLines;
    discovery.observeControlCommandTranscript(output);
    if (acceptanceTiming === 'after_output') {
      expect(completed).toEqual([]);
      expect(match && discovery.consumeAcceptedPromptMatch(match)).toBe(true);
    }
    expect(completed).toEqual([id]);
    discovery.observeControlCommandTranscript(output);
    expect(completed).toEqual([id]);
  });

  it('never treats native peer content as delivery of an accepted human prompt', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({ acceptedPromptWindowMs: 5_000, nowMs: () => 2_000 });
    discovery.recordAcceptedPrompt({ message: 'same visible text', acceptedAtMs: 1_000 });
    const peer = { type: 'user', uuid: 'native-peer', sessionId: 'recipient', timestamp: new Date(1_100).toISOString(),
      origin: { kind: 'peer', from: 'uds:/tmp/sender.sock', name: 'Sender' },
      message: { content: 'same visible text' } } satisfies RawJSONLines;
    expect(discovery.findMatchingTranscript([peer])).toBeNull();
    expect(discovery.consumeAcceptedPromptTranscriptEcho(peer)).toBe(false);
    expect(discovery.findMatchingTranscript([{ ...peer, uuid: 'human-prompt', origin: { kind: 'human' } }])).not.toBeNull();
  });

  it('retains one exact authenticated hook echo identity after the accepted batch correlation retires', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 2_000,
    });
    discovery.recordAcceptedPrompt({
      message: 'same visible text',
      acceptedAtMs: 1_000,
      deliveryIdentity: { localIds: ['hook-first-local-id'] },
      suppressTranscriptEcho: true,
    });

    expect(discovery.consumeAcceptedPromptByBatch({
      message: 'same visible text',
      userMessageLocalIds: ['hook-first-local-id'],
    })).toBe(true);
    expect(discovery.recordAcceptedPromptHookEcho({
      deliveryIdentity: { localIds: ['hook-first-local-id'] },
      promptId: 'accepted-hook-prompt-id',
      sessionId: 'accepted-hook-session-id',
    })).toBe(true);

    const exactEcho = {
      type: 'user',
      uuid: 'accepted-hook-user-row',
      promptId: 'accepted-hook-prompt-id',
      sessionId: 'accepted-hook-session-id',
      message: { role: 'user', content: 'same visible text' },
    } satisfies RawJSONLines;
    discovery.recordAcceptedPrompt({
      message: 'same visible text', deliveryIdentity: { localIds: ['later-identical-prompt'] },
    });
    expect(discovery.findMatchingTranscript([exactEcho])).toBeNull();
    expect(discovery.consumeAcceptedPromptTranscriptEcho(exactEcho)).toBe(true);
    expect(discovery.consumeAcceptedPromptTranscriptEcho(exactEcho)).toBe(false);
    expect(discovery.findMatchingTranscript([exactEcho])).toBeNull();
    expect(discovery.consumeAcceptedPromptTranscriptEcho({
      ...exactEcho,
      uuid: 'independent-same-text-user-row',
      promptId: 'independent-same-text-prompt-id',
    })).toBe(false);
  });

  it('reserves the exact JSONL-first echo without hiding a same-text row with another prompt identity', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 2_000,
    });
    discovery.recordAcceptedPrompt({
      message: 'same visible text',
      acceptedAtMs: 1_000,
      deliveryIdentity: { localIds: ['jsonl-first-local-id'] },
      suppressTranscriptEcho: true,
    });
    const exactEcho = {
      type: 'user',
      uuid: 'jsonl-first-user-row',
      promptId: 'jsonl-first-prompt-id',
      sessionId: 'jsonl-first-session-id',
      timestamp: new Date(1_100).toISOString(),
      message: { role: 'user', content: 'same visible text' },
    } satisfies RawJSONLines;
    const match = discovery.findMatchingTranscript([exactEcho]);

    expect(match).not.toBeNull();
    expect(discovery.reserveAcceptedPromptTranscriptEcho(match!)).toBe(true);
    expect(discovery.consumeAcceptedPromptMatch(match!)).toBe(true);
    expect(discovery.consumeAcceptedPromptTranscriptEcho(exactEcho)).toBe(true);
    expect(discovery.consumeAcceptedPromptTranscriptEcho({
      ...exactEcho,
      uuid: 'jsonl-first-independent-user-row',
      promptId: 'jsonl-first-independent-prompt-id',
    })).toBe(false);
  });

  it('keeps an exact durable Pending attempt eligible after a long provider-owned resume compaction', () => {
    let nowMs = 10_000;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => nowMs,
    });
    discovery.recordAcceptedPrompt({
      message: 'continue after the provider finishes compacting',
      acceptedAtMs: nowMs,
      deliveryIdentity: { localIds: ['durable-pending-local-id'], userMessageSeq: 71 },
    });

    nowMs = 150_000;

    expect(discovery.claimMatchingTranscript([{
      type: 'user',
      uuid: 'provider-user-after-long-resume-compaction',
      promptId: 'provider-prompt-after-long-resume-compaction',
      timestamp: new Date(nowMs).toISOString(),
      message: { role: 'user', content: 'continue after the provider finishes compacting' },
    } satisfies RawJSONLines])).toEqual(expect.objectContaining({
      deliveryIdentity: { localIds: ['durable-pending-local-id'], userMessageSeq: 71 },
    }));
  });

  it('keeps timestamp-less exact evidence eligible for a durable Pending attempt after a long provider-owned wait', () => {
    let nowMs = 10_000;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => nowMs,
    });
    discovery.recordAcceptedPrompt({
      message: 'continue after the provider-owned wait',
      acceptedAtMs: nowMs,
      deliveryIdentity: { localIds: ['durable-timestampless-local-id'] },
    });

    nowMs = 150_000;

    expect(discovery.claimMatchingTranscript([{
      type: 'user',
      uuid: 'provider-user-without-timestamp',
      promptId: 'provider-prompt-without-timestamp',
      message: { role: 'user', content: 'continue after the provider-owned wait' },
    } satisfies RawJSONLines])).toEqual(expect.objectContaining({
      deliveryIdentity: { localIds: ['durable-timestampless-local-id'] },
    }));
  });

  it('rejects whitespace-only provider acceptance identity before correlation', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 2_000,
    });
    discovery.recordAcceptedPrompt({
      message: 'accepted text',
      acceptedAtMs: 1_000,
      deliveryIdentity: { localIds: ['   '] },
    });

    expect(discovery.consumeAcceptedPromptByBatch({
      message: 'accepted text',
      userMessageLocalIds: ['   '],
    })).toBe(false);
  });

  it('never treats a sidechain user row as parent prompt-acceptance evidence', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 2_000,
    });
    discovery.recordAcceptedPrompt({
      message: 'the exact parent prompt',
      acceptedAtMs: 1_000,
      deliveryIdentity: { localIds: ['parent-local-id'] },
    });

    expect(discovery.findMatchingTranscript([{
      type: 'user',
      uuid: 'sidechain-user-row',
      isSidechain: true,
      timestamp: new Date(1_100).toISOString(),
      message: { role: 'user', content: 'the exact parent prompt' },
    } satisfies RawJSONLines])).toBeNull();
  });

  it('reports every local-command transcript observation to the canonical consumed-row owner', () => {
    const consumed: RawJSONLines[] = [];
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      onControlCommandConsumed: (message) => consumed.push(message),
    });
    const commandRow = {
      type: 'user',
      uuid: 'consumed-effort-command',
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    } satisfies RawJSONLines;
    const stdoutRow = {
      type: 'user',
      uuid: 'consumed-effort-stdout',
      parentUuid: 'consumed-effort-command',
      message: {
        role: 'user',
        content: '<local-command-stdout>Set effort level to high</local-command-stdout>',
      },
    } satisfies RawJSONLines;

    expect(discovery.observeControlCommandTranscript(commandRow)).toBe(true);
    expect(discovery.observeControlCommandTranscript(commandRow)).toBe(true);
    expect(discovery.observeControlCommandTranscript(stdoutRow)).toBe(true);
    expect(discovery.observeControlCommandTranscript({
      type: 'user',
      uuid: 'plain-user-row',
      message: { role: 'user', content: 'ordinary user text' },
    } satisfies RawJSONLines)).toBe(false);
    expect(consumed).toEqual([commandRow, commandRow, stdoutRow]);
  });

  it('does not let an independent runtime control satisfy an identical durable attempt', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 2_000,
    });
    discovery.recordIndependentControlCommand({
      message: '/effort high',
      submittedAtMs: 1_000,
    });
    discovery.recordAcceptedPrompt({
      message: '/effort high',
      acceptedAtMs: 2_000,
      deliveryIdentity: { localIds: ['durable-effort'] },
    });
    const independentControlRow = {
      type: 'user',
      uuid: 'runtime-control-effort',
      promptId: 'runtime-control-effort-prompt',
      timestamp: new Date(1_100).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    } satisfies RawJSONLines;

    expect(discovery.observeControlCommandTranscript(independentControlRow)).toBe(true);
    expect(discovery.findMatchingTranscript([independentControlRow])).toBeNull();
  });

  it('gives a later independent-control fence priority over an older identical durable attempt', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 1_500,
    });
    const durablePromptId = discovery.recordAcceptedPrompt({
      message: '/effort high',
      acceptedAtMs: 900,
      deliveryIdentity: { localIds: ['durable-effort'] },
    });
    discovery.recordIndependentControlCommand({
      message: '/effort high',
      submittedAtMs: 1_000,
    });
    const independentControlRow = {
      type: 'user',
      uuid: 'later-runtime-control-effort',
      promptId: 'later-runtime-control-effort-prompt',
      timestamp: new Date(1_100).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    } satisfies RawJSONLines;
    const durableAttemptRow = {
      type: 'user',
      uuid: 'durable-effort-command',
      promptId: 'durable-effort-command-prompt',
      timestamp: new Date(1_200).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    } satisfies RawJSONLines;

    expect(discovery.observeControlCommandTranscript(independentControlRow)).toBe(true);
    expect(discovery.findMatchingTranscript([independentControlRow])).toBeNull();

    expect(discovery.observeControlCommandTranscript(durableAttemptRow)).toBe(true);
    expect(discovery.findMatchingTranscript([durableAttemptRow])).toEqual(expect.objectContaining({
      acceptedPromptId: durablePromptId,
      deliveryIdentity: { localIds: ['durable-effort'] },
    }));
  });

  it('consumes multiple identical independent controls in FIFO order before matching a durable attempt', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 1_500,
    });
    discovery.recordIndependentControlCommand({ message: '/model opus', submittedAtMs: 1_000 });
    discovery.recordIndependentControlCommand({ message: '/model opus', submittedAtMs: 1_010 });
    const durablePromptId = discovery.recordAcceptedPrompt({
      message: '/model opus',
      acceptedAtMs: 1_020,
      deliveryIdentity: { localIds: ['durable-model'] },
    });
    const commandRow = (suffix: string, timestampMs: number): RawJSONLines => ({
      type: 'user',
      uuid: `model-command-${suffix}`,
      promptId: `model-prompt-${suffix}`,
      timestamp: new Date(timestampMs).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      },
    });
    const firstIndependentRow = commandRow('independent-1', 1_100);
    const secondIndependentRow = commandRow('independent-2', 1_200);
    const durableAttemptRow = commandRow('durable', 1_300);

    expect(discovery.observeControlCommandTranscript(firstIndependentRow)).toBe(true);
    expect(discovery.findMatchingTranscript([firstIndependentRow])).toBeNull();
    expect(discovery.observeControlCommandTranscript(secondIndependentRow)).toBe(true);
    expect(discovery.findMatchingTranscript([secondIndependentRow])).toBeNull();

    expect(discovery.observeControlCommandTranscript(durableAttemptRow)).toBe(true);
    expect(discovery.findMatchingTranscript([durableAttemptRow])).toEqual(expect.objectContaining({
      acceptedPromptId: durablePromptId,
      deliveryIdentity: { localIds: ['durable-model'] },
    }));
  });

  it('does not bind a replayed pre-registration command to a new independent control', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 2_100,
    });
    discovery.recordIndependentControlCommand({
      message: '/effort high',
      submittedAtMs: 1_000,
    });
    const staleReplayRow = {
      type: 'user',
      uuid: 'stale-effort-command',
      promptId: 'stale-effort-prompt',
      timestamp: new Date(900).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    } satisfies RawJSONLines;
    const actualIndependentRow = {
      type: 'user',
      uuid: 'actual-effort-command',
      promptId: 'actual-effort-prompt',
      timestamp: new Date(1_100).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    } satisfies RawJSONLines;

    expect(discovery.observeControlCommandTranscript(staleReplayRow)).toBe(true);
    expect(discovery.observeControlCommandTranscript(actualIndependentRow)).toBe(true);
    discovery.recordAcceptedPrompt({
      message: '/effort high',
      acceptedAtMs: 2_000,
      deliveryIdentity: { localIds: ['durable-effort'] },
    });

    expect(discovery.findMatchingTranscript([actualIndependentRow])).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['equal-millisecond', new Date(1_000).toISOString()],
  ] as const)(
    'keeps %s timestamp command evidence fail-closed at an independent-control provenance fence',
    (_label, timestamp) => {
      const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
        acceptedPromptWindowMs: 5_000,
        nowMs: () => 2_100,
      });
      discovery.recordIndependentControlCommand({
        message: '/effort high',
        submittedAtMs: 1_000,
      });
      const unprovableRow = {
        type: 'user',
        uuid: `unprovable-effort-${_label}`,
        promptId: `unprovable-effort-prompt-${_label}`,
        ...(timestamp === undefined ? {} : { timestamp }),
        message: {
          role: 'user',
          content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
        },
      } satisfies RawJSONLines;
      const actualIndependentRow = {
        type: 'user',
        uuid: `actual-effort-${_label}`,
        promptId: `actual-effort-prompt-${_label}`,
        timestamp: new Date(1_100).toISOString(),
        message: {
          role: 'user',
          content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
        },
      } satisfies RawJSONLines;

      expect(discovery.observeControlCommandTranscript(unprovableRow)).toBe(true);
      expect(discovery.observeControlCommandTranscript(actualIndependentRow)).toBe(true);
      discovery.recordAcceptedPrompt({
        message: '/effort high',
        acceptedAtMs: 2_000,
        deliveryIdentity: { localIds: [`durable-effort-${_label}`] },
      });

      expect(discovery.findMatchingTranscript([unprovableRow])).toBeNull();
      expect(discovery.findMatchingTranscript([actualIndependentRow])).toBeNull();
    },
  );

  it.each([
    ['missing', undefined],
    ['equal-millisecond', new Date(1_000).toISOString()],
  ] as const)(
    'does not let %s timestamp evidence bypass an independent-control fence for an older durable attempt',
    (_label, timestamp) => {
      const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
        acceptedPromptWindowMs: 5_000,
        nowMs: () => 2_100,
      });
      discovery.recordAcceptedPrompt({
        message: '/effort high',
        acceptedAtMs: 900,
        deliveryIdentity: { localIds: [`durable-effort-${_label}`] },
      });
      discovery.recordIndependentControlCommand({
        message: '/effort high',
        submittedAtMs: 1_000,
      });
      const unprovableRow = {
        type: 'user',
        uuid: `durable-first-unprovable-effort-${_label}`,
        promptId: `durable-first-unprovable-effort-prompt-${_label}`,
        ...(timestamp === undefined ? {} : { timestamp }),
        message: {
          role: 'user',
          content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
        },
      } satisfies RawJSONLines;

      expect(discovery.observeControlCommandTranscript(unprovableRow)).toBe(true);
      expect(discovery.findMatchingTranscript([unprovableRow])).toBeNull();
    },
  );

  it('keeps closed command evidence as a bounded tombstone across duplicate transcript ingress', () => {
    const completedPromptEvidenceIds: string[] = [];
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 2_100,
      onAttemptLocalCommandCompleted: ({ acceptedPromptId }) => {
        completedPromptEvidenceIds.push(acceptedPromptId);
      },
    });
    const firstAcceptedPromptId = discovery.recordAcceptedPrompt({
      message: '/model opus',
      acceptedAtMs: 2_000,
      deliveryIdentity: { localIds: ['first-durable-model'] },
    });
    const commandRow = {
      type: 'user',
      uuid: 'replayed-model-command',
      promptId: 'replayed-model-prompt',
      timestamp: new Date(2_050).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      },
    } satisfies RawJSONLines;
    const stdoutRow = {
      type: 'user',
      uuid: 'replayed-model-stdout',
      parentUuid: 'replayed-model-command',
      promptId: 'replayed-model-prompt',
      timestamp: new Date(2_060).toISOString(),
      message: {
        role: 'user',
        content: '<local-command-stdout>Set model to Opus</local-command-stdout>',
      },
    } satisfies RawJSONLines;

    expect(discovery.observeControlCommandTranscript(commandRow)).toBe(true);
    const firstMatch = discovery.findMatchingTranscript([commandRow]);
    expect(firstMatch).toEqual(expect.objectContaining({ acceptedPromptId: firstAcceptedPromptId }));
    expect(firstMatch && discovery.consumeAcceptedPromptMatch(firstMatch)).toBe(true);
    expect(discovery.observeControlCommandTranscript(stdoutRow)).toBe(true);
    expect(completedPromptEvidenceIds).toEqual([firstAcceptedPromptId]);

    discovery.recordAcceptedPrompt({
      message: '/model opus',
      acceptedAtMs: 2_100,
      deliveryIdentity: { localIds: ['second-durable-model'] },
    });

    expect(discovery.findMatchingTranscript([commandRow])).toBeNull();
    expect(discovery.observeControlCommandTranscript(stdoutRow)).toBe(true);
    expect(completedPromptEvidenceIds).toEqual([firstAcceptedPromptId]);
  });

  it('keeps consumed control evidence closed through the full symmetric durable replay horizon', () => {
    let nowMs = 2_050;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => nowMs,
    });
    const commandRow = {
      type: 'user',
      uuid: 'symmetric-horizon-model-command',
      promptId: 'symmetric-horizon-model-prompt',
      timestamp: new Date(2_050).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      },
    } satisfies RawJSONLines;
    const firstPromptId = discovery.recordAcceptedPrompt({
      message: '/model opus',
      acceptedAtMs: 2_000,
      deliveryIdentity: { localIds: ['first-model'] },
    });

    const firstMatch = discovery.findMatchingTranscript([commandRow]);
    expect(firstMatch).toEqual(expect.objectContaining({ acceptedPromptId: firstPromptId }));
    expect(firstMatch && discovery.consumeAcceptedPromptMatch(firstMatch)).toBe(true);

    // The old binding TTL ended at 7_050, but the symmetric early-row window still permits this
    // row for an attempt accepted at 7_000. Replaying the closed row must never settle it.
    nowMs = 7_040;
    discovery.recordAcceptedPrompt({
      message: '/model opus',
      acceptedAtMs: 7_000,
      deliveryIdentity: { localIds: ['second-model'] },
    });
    nowMs = 7_100;

    expect(discovery.findMatchingTranscript([commandRow])).toBeNull();
  });

  it('keeps a one-row ambiguous retry episode fail-closed until its bounded registrations expire', () => {
    let nowMs = 1_000;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => nowMs,
    });
    const commandRow = (suffix: string, timestampMs: number): RawJSONLines => ({
      type: 'user',
      uuid: `retry-model-command-${suffix}`,
      promptId: `retry-model-prompt-${suffix}`,
      timestamp: new Date(timestampMs).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      },
    });

    const ambiguousSubmissionId = discovery.recordIndependentControlCommand({
      message: '/model opus',
      submittedAtMs: 1_000,
    });
    expect(ambiguousSubmissionId).not.toBeNull();
    expect(discovery.recordIndependentControlCommandDisposition({
      submissionId: ambiguousSubmissionId as string,
      disposition: 'ambiguous',
    })).toBe(true);

    nowMs = 1_100;
    const retrySubmissionId = discovery.recordIndependentControlCommand({
      message: '/model opus',
      submittedAtMs: 1_100,
    });
    expect(retrySubmissionId).not.toBe(ambiguousSubmissionId);
    expect(discovery.recordIndependentControlCommandDisposition({
      submissionId: retrySubmissionId as string,
      disposition: 'sent',
    })).toBe(true);

    // The first row after an ambiguous write belongs to the ambiguous predecessor even when it is
    // appended after the retry fence. The retry registration remains as the bounded second-write
    // possibility instead of being stolen by the delayed predecessor.
    const retryRow = commandRow('actual', 1_150);
    expect(discovery.findMatchingTranscript([retryRow])).toBeNull();

    nowMs = 1_200;
    const durablePromptId = discovery.recordAcceptedPrompt({
      message: '/model opus',
      acceptedAtMs: 1_200,
      deliveryIdentity: { localIds: ['durable-after-retry'] },
    });
    const durableRowDuringAmbiguousEpisode = commandRow('durable-during-episode', 1_250);
    expect(discovery.findMatchingTranscript([durableRowDuringAmbiguousEpisode])).toBeNull();

    // The ambiguity is bounded: after the retry registration expires, new exact evidence may
    // confirm the still-live durable attempt.
    nowMs = 6_150;
    const durableRowAfterEpisode = commandRow('durable-after-episode', 6_150);
    expect(discovery.findMatchingTranscript([durableRowAfterEpisode])).toEqual(expect.objectContaining({
      acceptedPromptId: durablePromptId,
      deliveryIdentity: { localIds: ['durable-after-retry'] },
    }));
  });

  it('keeps a row from an ambiguous prior write fail-closed across a retry boundary', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 1_200,
    });
    const priorSubmissionId = discovery.recordIndependentControlCommand({
      message: '/effort high',
      submittedAtMs: 1_000,
    });
    discovery.recordIndependentControlCommandDisposition({
      submissionId: priorSubmissionId as string,
      disposition: 'ambiguous',
    });
    const retrySubmissionId = discovery.recordIndependentControlCommand({
      message: '/effort high',
      submittedAtMs: 1_100,
    });
    discovery.recordIndependentControlCommandDisposition({
      submissionId: retrySubmissionId as string,
      disposition: 'sent',
    });
    const priorRow = {
      type: 'user',
      uuid: 'ambiguous-prior-effort-command',
      promptId: 'ambiguous-prior-effort-prompt',
      timestamp: new Date(1_050).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    } satisfies RawJSONLines;

    expect(discovery.findMatchingTranscript([priorRow])).toBeNull();
    discovery.recordAcceptedPrompt({
      message: '/effort high',
      acceptedAtMs: 1_200,
      deliveryIdentity: { localIds: ['durable-effort'] },
    });
    expect(discovery.findMatchingTranscript([priorRow])).toBeNull();
  });

  it.each([
    ['ambiguous predecessor first', ['ambiguous-predecessor', 'genuine-retry']],
    ['genuine retry first', ['genuine-retry', 'ambiguous-predecessor']],
  ] as const)(
    'keeps both possible independent rows non-durable when %s after the retry fence',
    (_label, arrivalOrder) => {
      let nowMs = 1_000;
      const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
        acceptedPromptWindowMs: 5_000,
        nowMs: () => nowMs,
      });
      const commandRow = (id: string, timestampMs: number): RawJSONLines => ({
        type: 'user',
        uuid: id,
        promptId: `${id}-prompt`,
        timestamp: new Date(timestampMs).toISOString(),
        message: {
          role: 'user',
          content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
        },
      });
      const rows = {
        'ambiguous-predecessor': commandRow('ambiguous-predecessor', 1_150),
        'genuine-retry': commandRow('genuine-retry', 1_160),
      } as const;

      const predecessorId = discovery.recordIndependentControlCommand({
        message: '/effort high',
        submittedAtMs: 1_000,
      });
      discovery.recordIndependentControlCommandDisposition({
        submissionId: predecessorId as string,
        disposition: 'ambiguous',
      });
      nowMs = 1_100;
      const retryId = discovery.recordIndependentControlCommand({
        message: '/effort high',
        submittedAtMs: 1_100,
      });
      discovery.recordIndependentControlCommandDisposition({
        submissionId: retryId as string,
        disposition: 'sent',
      });

      for (const rowId of arrivalOrder) {
        expect(discovery.findMatchingTranscript([rows[rowId]])).toBeNull();
      }

      nowMs = 1_200;
      const durablePromptId = discovery.recordAcceptedPrompt({
        message: '/effort high',
        acceptedAtMs: 1_200,
        deliveryIdentity: { localIds: ['durable-after-two-write-retry'] },
      });
      for (const rowId of arrivalOrder) {
        expect(discovery.findMatchingTranscript([rows[rowId]])).toBeNull();
      }

      const actualDurableRow = commandRow('actual-durable', 1_250);
      expect(discovery.findMatchingTranscript([actualDurableRow])).toEqual(expect.objectContaining({
        acceptedPromptId: durablePromptId,
        deliveryIdentity: { localIds: ['durable-after-two-write-retry'] },
      }));
    },
  );

  it('keeps an ambiguous predecessor and its retry in one expiry episode', () => {
    let nowMs = 1_000;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => nowMs,
    });
    const commandRow = (id: string, timestampMs: number): RawJSONLines => ({
      type: 'user',
      uuid: id,
      promptId: `${id}-prompt`,
      timestamp: new Date(timestampMs).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    });

    const predecessorId = discovery.recordIndependentControlCommand({
      message: '/effort high',
      submittedAtMs: 1_000,
    });
    discovery.recordIndependentControlCommandDisposition({
      submissionId: predecessorId as string,
      disposition: 'ambiguous',
    });
    nowMs = 1_100;
    const retryId = discovery.recordIndependentControlCommand({
      message: '/effort high',
      submittedAtMs: 1_100,
    });
    discovery.recordIndependentControlCommandDisposition({
      submissionId: retryId as string,
      disposition: 'sent',
    });

    nowMs = 6_000;
    const durablePromptId = discovery.recordAcceptedPrompt({
      message: '/effort high',
      acceptedAtMs: 6_000,
      deliveryIdentity: { localIds: ['durable-between-control-expiries'] },
    });
    nowMs = 6_050;
    const delayedPredecessorRow = commandRow('delayed-predecessor-between-expiries', 6_050);
    const genuineRetryRow = commandRow('genuine-retry-between-expiries', 6_060);

    expect(discovery.findMatchingTranscript([delayedPredecessorRow])).toBeNull();
    expect(discovery.findMatchingTranscript([genuineRetryRow])).toBeNull();
    expect(discovery.findMatchingTranscript([
      commandRow('actual-durable-between-expiries', 6_070),
    ])).toEqual(expect.objectContaining({
      acceptedPromptId: durablePromptId,
      deliveryIdentity: { localIds: ['durable-between-control-expiries'] },
    }));
  });

  it('shares the expiry episode when Claude omits arguments from related control echoes', () => {
    let nowMs = 1_000;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => nowMs,
    });
    const commandRow = (id: string, timestampMs: number, args: string): RawJSONLines => ({
      type: 'user',
      uuid: id,
      promptId: `${id}-prompt`,
      timestamp: new Date(timestampMs).toISOString(),
      message: {
        role: 'user',
        content: `<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>${args}</command-args>`,
      },
    });

    const predecessorId = discovery.recordIndependentControlCommand({
      message: '/effort low',
      submittedAtMs: 1_000,
    });
    discovery.recordIndependentControlCommandDisposition({
      submissionId: predecessorId as string,
      disposition: 'ambiguous',
    });
    nowMs = 1_100;
    const retryId = discovery.recordIndependentControlCommand({
      message: '/effort high',
      submittedAtMs: 1_100,
    });
    discovery.recordIndependentControlCommandDisposition({
      submissionId: retryId as string,
      disposition: 'sent',
    });

    nowMs = 6_000;
    const durablePromptId = discovery.recordAcceptedPrompt({
      message: '/effort high',
      acceptedAtMs: 6_000,
      deliveryIdentity: { localIds: ['durable-after-argument-change'] },
    });
    nowMs = 6_050;
    expect(discovery.findMatchingTranscript([
      commandRow('delayed-argumentless-predecessor', 6_050, ''),
    ])).toBeNull();
    expect(discovery.findMatchingTranscript([
      commandRow('genuine-high-retry', 6_060, 'high'),
    ])).toBeNull();
    expect(discovery.findMatchingTranscript([
      commandRow('actual-high-durable', 6_070, 'high'),
    ])).toEqual(expect.objectContaining({
      acceptedPromptId: durablePromptId,
      deliveryIdentity: { localIds: ['durable-after-argument-change'] },
    }));
  });

  it('does not extend an unrelated control while extending a retry episode', () => {
    let nowMs = 1_000;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => nowMs,
    });
    const recordControl = (message: string, submittedAtMs: number) => {
      const submissionId = discovery.recordIndependentControlCommand({ message, submittedAtMs });
      discovery.recordIndependentControlCommandDisposition({
        submissionId: submissionId as string,
        disposition: 'sent',
      });
    };
    recordControl('/effort low', 1_000);
    recordControl('/model opus', 1_050);
    recordControl('/effort high', 1_100);

    nowMs = 6_070;
    const durablePromptId = discovery.recordAcceptedPrompt({
      message: '/model opus',
      acceptedAtMs: 6_070,
      deliveryIdentity: { localIds: ['durable-after-unrelated-expiry'] },
    });
    const durableRow = {
      type: 'user',
      uuid: 'durable-after-unrelated-expiry',
      promptId: 'durable-after-unrelated-expiry-prompt',
      timestamp: new Date(6_080).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      },
    } satisfies RawJSONLines;

    expect(discovery.findMatchingTranscript([durableRow])).toEqual(expect.objectContaining({
      acceptedPromptId: durablePromptId,
      deliveryIdentity: { localIds: ['durable-after-unrelated-expiry'] },
    }));
  });

  it('never rebinds a timestamp-less historical control row to a later durable attempt', () => {
    let nowMs = 10_000;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => nowMs,
    });
    const historicalRow = {
      type: 'user',
      uuid: 'historical-missing-timestamp',
      promptId: 'historical-missing-timestamp-prompt',
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    } satisfies RawJSONLines;

    expect(discovery.observeControlCommandTranscript(historicalRow)).toBe(true);
    nowMs = 10_010;
    discovery.recordAcceptedPrompt({
      message: '/effort high',
      acceptedAtMs: 10_010,
      deliveryIdentity: { localIds: ['later-durable-effort'] },
    });

    expect(discovery.findMatchingTranscript([historicalRow])).toBeNull();
  });

  it('emits one attempt-bound local-command completion only after exact acceptance and stdout', () => {
    const completedPromptEvidenceIds: string[] = [];
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 2_000,
      onAttemptLocalCommandCompleted: ({ acceptedPromptId }) => {
        completedPromptEvidenceIds.push(acceptedPromptId);
      },
    });
    const acceptedPromptId = discovery.recordAcceptedPrompt({
      message: '/model opus',
      acceptedAtMs: 2_000,
      deliveryIdentity: { localIds: ['durable-model'] },
    });
    const commandRow = {
      type: 'user',
      uuid: 'attempt-model-command',
      promptId: 'attempt-model-prompt',
      timestamp: new Date(2_050).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      },
    } satisfies RawJSONLines;
    const stdoutRow = {
      type: 'user',
      uuid: 'attempt-model-stdout',
      parentUuid: 'attempt-model-command',
      promptId: 'attempt-model-prompt',
      timestamp: new Date(2_060).toISOString(),
      message: {
        role: 'user',
        content: '<local-command-stdout>Set model to Opus</local-command-stdout>',
      },
    } satisfies RawJSONLines;

    expect(discovery.observeControlCommandTranscript(commandRow)).toBe(true);
    const match = discovery.findMatchingTranscript([commandRow]);
    expect(match).toEqual(expect.objectContaining({ acceptedPromptId }));
    expect(completedPromptEvidenceIds).toEqual([]);

    expect(match && discovery.consumeAcceptedPromptMatch(match)).toBe(true);
    expect(completedPromptEvidenceIds).toEqual([]);

    expect(discovery.observeControlCommandTranscript(stdoutRow)).toBe(true);
    expect(completedPromptEvidenceIds).toEqual([acceptedPromptId]);
    expect(discovery.observeControlCommandTranscript(stdoutRow)).toBe(true);
    expect(completedPromptEvidenceIds).toEqual([acceptedPromptId]);
  });

  it('rebinds command and stdout evidence observed before terminal injection returns', () => {
    const completedPromptEvidenceIds: string[] = [];
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 2_100,
      onAttemptLocalCommandCompleted: ({ acceptedPromptId }) => {
        completedPromptEvidenceIds.push(acceptedPromptId);
      },
    });
    const commandRow = {
      type: 'user',
      uuid: 'early-effort-command',
      promptId: 'early-effort-prompt',
      timestamp: new Date(2_050).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    } satisfies RawJSONLines;
    const stdoutRow = {
      type: 'user',
      uuid: 'early-effort-stdout',
      parentUuid: 'early-effort-command',
      promptId: 'early-effort-prompt',
      timestamp: new Date(2_060).toISOString(),
      message: {
        role: 'user',
        content: '<local-command-stdout>Set effort level to high</local-command-stdout>',
      },
    } satisfies RawJSONLines;

    expect(discovery.observeControlCommandTranscript(commandRow)).toBe(true);
    expect(discovery.observeControlCommandTranscript(stdoutRow)).toBe(true);
    const acceptedPromptId = discovery.recordAcceptedPrompt({
      message: '/effort high',
      acceptedAtMs: 2_000,
      deliveryIdentity: { localIds: ['early-effort'] },
    });

    const match = discovery.findMatchingTranscript([commandRow]);
    expect(match).toEqual(expect.objectContaining({ acceptedPromptId }));
    expect(match && discovery.consumeAcceptedPromptMatch(match)).toBe(true);
    expect(completedPromptEvidenceIds).toEqual([acceptedPromptId]);
  });

  it.each(['/compact', '/btw ask a side question'])(
    'keeps conversation-affecting local command %s on its external lifecycle owner',
    (prompt) => {
      const completedPromptEvidenceIds: string[] = [];
      const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
        acceptedPromptWindowMs: 5_000,
        nowMs: () => 2_100,
        onAttemptLocalCommandCompleted: ({ acceptedPromptId }) => {
          completedPromptEvidenceIds.push(acceptedPromptId);
        },
      });
      const commandName = prompt.split(/\s/u, 1)[0] ?? prompt;
      const acceptedPromptId = discovery.recordAcceptedPrompt({
        message: prompt,
        acceptedAtMs: 2_000,
        deliveryIdentity: { localIds: [`durable-${commandName.slice(1)}`] },
      });
      const commandRow = {
        type: 'user',
        uuid: `${commandName}-command`,
        promptId: `${commandName}-prompt`,
        timestamp: new Date(2_050).toISOString(),
        message: {
          role: 'user',
          content: `<command-name>${commandName}</command-name>\n<command-message>${commandName.slice(1)}</command-message>\n<command-args>${prompt.slice(commandName.length).trim()}</command-args>`,
        },
      } satisfies RawJSONLines;
      const stdoutRow = {
        type: 'user',
        uuid: `${commandName}-stdout`,
        parentUuid: `${commandName}-command`,
        promptId: `${commandName}-prompt`,
        timestamp: new Date(2_060).toISOString(),
        message: {
          role: 'user',
          content: '<local-command-stdout>Local command acknowledged</local-command-stdout>',
        },
      } satisfies RawJSONLines;

      expect(discovery.observeControlCommandTranscript(commandRow)).toBe(true);
      const match = discovery.findMatchingTranscript([commandRow]);
      expect(match).toEqual(expect.objectContaining({ acceptedPromptId }));
      expect(match && discovery.consumeAcceptedPromptMatch(match)).toBe(true);
      expect(discovery.observeControlCommandTranscript(stdoutRow)).toBe(true);
      expect(completedPromptEvidenceIds).toEqual([]);
    },
  );

  it('settles a terminal-only status command after exact acceptance and stdout', () => {
    const completedPromptEvidenceIds: string[] = [];
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 2_100,
      onAttemptLocalCommandCompleted: ({ acceptedPromptId }) => {
        completedPromptEvidenceIds.push(acceptedPromptId);
      },
    });
    const acceptedPromptId = discovery.recordAcceptedPrompt({
      message: '/status',
      acceptedAtMs: 2_000,
      deliveryIdentity: { localIds: ['durable-status'] },
    });
    const commandRow = {
      type: 'user',
      uuid: 'status-command',
      promptId: 'status-prompt',
      timestamp: new Date(2_050).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/status</command-name>\n<command-message>status</command-message>\n<command-args></command-args>',
      },
    } satisfies RawJSONLines;
    const stdoutRow = {
      type: 'user',
      uuid: 'status-stdout',
      parentUuid: 'status-command',
      promptId: 'status-prompt',
      timestamp: new Date(2_060).toISOString(),
      message: {
        role: 'user',
        content: '<local-command-stdout>Status rendered</local-command-stdout>',
      },
    } satisfies RawJSONLines;

    expect(discovery.observeControlCommandTranscript(commandRow)).toBe(true);
    const match = discovery.findMatchingTranscript([commandRow]);
    expect(match).toEqual(expect.objectContaining({ acceptedPromptId }));
    expect(match && discovery.consumeAcceptedPromptMatch(match)).toBe(true);
    expect(discovery.observeControlCommandTranscript(stdoutRow)).toBe(true);
    expect(completedPromptEvidenceIds).toEqual([acceptedPromptId]);
  });

  it('keeps queued-command enqueue as custody and accepts only exact native main-chain consumption', () => {
    const prompt = 'Please continue the QA from the current checkpoint.';
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const enqueuedAt = new Date(10_250).toISOString();
    const attachedAt = new Date(10_245).toISOString();
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_000,
      deliveryIdentity: { localIds: ['queued-steer-local-id'], userMessageSeq: 93 },
    });

    expect(discovery.findMatchingTranscript([{
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: enqueuedAt,
      sessionId,
      content: prompt,
    } as unknown as RawJSONLines])).toBeNull();

    expect(discovery.findMatchingTranscript([{
      type: 'queue-operation',
      operation: 'remove',
      timestamp: new Date(10_500).toISOString(),
      sessionId,
      content: prompt,
    } as unknown as RawJSONLines])).toBeNull();

    const match = discovery.findMatchingTranscript([{
      parentUuid: 'main-chain-parent',
      isSidechain: false,
      type: 'attachment',
      uuid: 'accepted-queued-command',
      timestamp: attachedAt,
      sessionId,
      attachment: {
        type: 'queued_command',
        prompt,
        commandMode: 'prompt',
        origin: { kind: 'human' },
        timestamp: attachedAt,
      },
    } as unknown as RawJSONLines]);

    expect(match).toEqual(expect.objectContaining({
      deliveryIdentity: { localIds: ['queued-steer-local-id'], userMessageSeq: 93 },
      transcriptUuid: 'accepted-queued-command',
    }));
    expect(match && discovery.consumeAcceptedPromptMatch(match)).toBe(true);
  });

  it('consumes repeated identical native queue episodes in chronological one-to-one order', () => {
    const prompt = 'repeat this exact queued prompt';
    const sessionId = 'abababab-abab-4bab-8bab-abababababab';
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_000,
      deliveryIdentity: { localIds: ['first-identical-episode'] },
    });

    for (const timestampMs of [10_250, 10_750]) {
      if (timestampMs === 10_750) {
        discovery.recordAcceptedPrompt({
          message: prompt,
          acceptedAtMs: 10_001,
          deliveryIdentity: { localIds: ['second-identical-episode'] },
        });
      }
      expect(discovery.findMatchingTranscript([{
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: new Date(timestampMs).toISOString(),
        sessionId,
        content: prompt,
      } as unknown as RawJSONLines])).toBeNull();
    }
    for (const timestampMs of [10_500, 11_000]) {
      expect(discovery.findMatchingTranscript([{
        type: 'queue-operation',
        operation: 'remove',
        timestamp: new Date(timestampMs).toISOString(),
        sessionId,
        content: prompt,
      } as unknown as RawJSONLines])).toBeNull();
    }

    const consumeEpisode = (episode: number, attachedAtMs: number) => discovery.claimMatchingTranscript([{
      parentUuid: `identical-parent-${episode}`,
      isSidechain: false,
      type: 'attachment',
      uuid: `identical-attachment-${episode}`,
      timestamp: new Date(attachedAtMs).toISOString(),
      sessionId,
      attachment: {
        type: 'queued_command',
        prompt,
        commandMode: 'prompt',
        origin: { kind: 'human' },
        timestamp: new Date(attachedAtMs).toISOString(),
      },
    } as unknown as RawJSONLines]);

    expect(consumeEpisode(1, 10_245)?.deliveryIdentity).toEqual({
      localIds: ['first-identical-episode'],
    });
    expect(consumeEpisode(2, 10_744)?.deliveryIdentity).toEqual({
      localIds: ['second-identical-episode'],
    });
  });

  it('keeps consumeMatchingTranscript receiver-independent', () => {
    const prompt = 'Please continue the QA from the current checkpoint.';
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });
    const { consumeMatchingTranscript } = discovery;

    discovery.recordAcceptedPrompt({ message: prompt, acceptedAtMs: 10_000 });

    expect(consumeMatchingTranscript([{
      type: 'user',
      uuid: 'receiver-independent-user-row',
      timestamp: new Date(10_250).toISOString(),
      message: { role: 'user', content: prompt },
    } satisfies RawJSONLines])).toBe(true);
  });

  it('does not consume a queued-command attachment without the exact native queue lifecycle', () => {
    const prompt = 'Please continue fully and completely.';
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: prompt, acceptedAtMs: 10_000 });

    expect(discovery.consumeMatchingTranscript([{
      isSidechain: false,
      type: 'attachment',
      uuid: 'unpaired-queued-command',
      timestamp: new Date(10_250).toISOString(),
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attachment: {
        type: 'queued_command',
        prompt,
        commandMode: 'prompt',
        origin: { kind: 'human' },
        timestamp: new Date(10_250).toISOString(),
      },
    } as unknown as RawJSONLines])).toBe(false);
  });

  it('rejects sidechain, non-human, non-prompt, and foreign-session queued consumption', () => {
    const prompt = 'only the exact current native queue episode may settle';
    const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const enqueuedAt = new Date(10_250).toISOString();
    const invalidAttachments: ReadonlyArray<Readonly<{
      label: string;
      build: () => Record<string, unknown>;
    }>> = [
      {
        label: 'sidechain',
        build: () => ({
          parentUuid: 'parent-sidechain', isSidechain: true, type: 'attachment', uuid: 'sidechain',
          timestamp: enqueuedAt, sessionId,
          attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: enqueuedAt },
        }),
      },
      {
        label: 'non-human',
        build: () => ({
          parentUuid: 'parent-agent', isSidechain: false, type: 'attachment', uuid: 'agent-origin',
          timestamp: enqueuedAt, sessionId,
          attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'agent' }, timestamp: enqueuedAt },
        }),
      },
      {
        label: 'non-prompt',
        build: () => ({
          parentUuid: 'parent-control', isSidechain: false, type: 'attachment', uuid: 'control-mode',
          timestamp: enqueuedAt, sessionId,
          attachment: { type: 'queued_command', prompt, commandMode: 'control', origin: { kind: 'human' }, timestamp: enqueuedAt },
        }),
      },
      {
        label: 'foreign-session',
        build: () => ({
          parentUuid: 'parent-foreign', isSidechain: false, type: 'attachment', uuid: 'foreign-session',
          timestamp: enqueuedAt, sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: enqueuedAt },
        }),
      },
    ];

    for (const variant of invalidAttachments) {
      const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
        acceptedPromptWindowMs: 5_000,
        nowMs: () => 10_000,
      });
      discovery.recordAcceptedPrompt({
        message: prompt,
        acceptedAtMs: 10_000,
        deliveryIdentity: { localIds: [`current-${variant.label}`] },
      });
      expect(discovery.consumeMatchingTranscript([{
        type: 'queue-operation', operation: 'enqueue', timestamp: enqueuedAt, sessionId, content: prompt,
      } as unknown as RawJSONLines])).toBe(false);
      expect(discovery.consumeMatchingTranscript([{
        type: 'queue-operation', operation: 'remove', timestamp: new Date(10_500).toISOString(), sessionId, content: prompt,
      } as unknown as RawJSONLines])).toBe(false);
      expect(discovery.consumeMatchingTranscript([variant.build() as unknown as RawJSONLines])).toBe(false);
    }
  });

  it('keeps duplicate and conflicting native queue evidence idempotent and fail-closed', () => {
    const prompt = 'dedupe the exact native queue episode';
    const sessionId = '99999999-9999-4999-8999-999999999999';
    const enqueuedAt = new Date(10_250).toISOString();
    const enqueue = {
      type: 'queue-operation', operation: 'enqueue', timestamp: enqueuedAt, sessionId, content: prompt,
    } as unknown as RawJSONLines;
    const remove = {
      type: 'queue-operation', operation: 'remove', timestamp: new Date(10_500).toISOString(), sessionId, content: prompt,
    } as unknown as RawJSONLines;
    const attachment = {
      parentUuid: 'dedupe-parent', isSidechain: false, type: 'attachment', uuid: 'dedupe-attachment',
      timestamp: enqueuedAt, sessionId,
      attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: enqueuedAt },
    } as unknown as RawJSONLines;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });
    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_000,
      deliveryIdentity: { localIds: ['dedupe-current-local-id'] },
    });

    expect(discovery.consumeMatchingTranscript([enqueue])).toBe(false);
    expect(discovery.consumeMatchingTranscript([enqueue])).toBe(false);
    expect(discovery.consumeMatchingTranscript([{
      type: 'queue-operation',
      operation: 'remove',
      timestamp: new Date(10_400).toISOString(),
      sessionId,
      content: 'foreign content',
    } as unknown as RawJSONLines])).toBe(false);
    expect(discovery.consumeMatchingTranscript([attachment])).toBe(false);
    expect(discovery.consumeMatchingTranscript([remove])).toBe(false);
    expect(discovery.consumeMatchingTranscript([remove])).toBe(false);
    expect(discovery.consumeMatchingTranscript([attachment])).toBe(true);
    expect(discovery.consumeMatchingTranscript([attachment])).toBe(false);
  });

  it('does not bind a command-name-only queue episode to the current Pending attempt', () => {
    const sessionId = 'abababab-abab-4bab-8bab-abababababab';
    const enqueuedAt = new Date(10_250).toISOString();
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });
    discovery.recordAcceptedPrompt({
      message: '/model opus',
      acceptedAtMs: 10_000,
      deliveryIdentity: { localIds: ['exact-current-only'] },
    });
    expect(discovery.consumeMatchingTranscript([{
      type: 'queue-operation', operation: 'enqueue', timestamp: enqueuedAt, sessionId, content: '/model',
    } as unknown as RawJSONLines])).toBe(false);
    expect(discovery.consumeMatchingTranscript([{
      type: 'queue-operation', operation: 'remove', timestamp: new Date(10_500).toISOString(), sessionId, content: '/model',
    } as unknown as RawJSONLines])).toBe(false);
    expect(discovery.consumeMatchingTranscript([{
      parentUuid: 'partial-parent', isSidechain: false, type: 'attachment',
      uuid: 'rejected-command-name-only', timestamp: enqueuedAt, sessionId,
      attachment: {
        type: 'queued_command', prompt: '/model', commandMode: 'prompt',
        origin: { kind: 'human' }, timestamp: enqueuedAt,
      },
    } as unknown as RawJSONLines])).toBe(false);
  });

  it('does not consume Claude queued-command removal rows as provider-accepted input', () => {
    const prompt = 'Please continue fully and completely.';
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: prompt, acceptedAtMs: 10_000 });

    expect(discovery.consumeMatchingTranscript([{
      type: 'queue-operation',
      operation: 'remove',
      timestamp: new Date(10_250).toISOString(),
      content: prompt,
    } as unknown as RawJSONLines])).toBe(false);
  });

  it('does not consume meta continuation transcript rows as provider-accepted input', () => {
    const prompt = GENERIC_CONTINUATION_RESUME_PROMPT;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: prompt, acceptedAtMs: 10_000 });

    expect(discovery.consumeMatchingTranscript([{
      type: 'user',
      uuid: 'meta-continuation-prompt',
      isMeta: true,
      timestamp: new Date(10_100).toISOString(),
      message: {
        role: 'user',
        content: prompt,
      },
    } satisfies RawJSONLines])).toBe(false);

    expect(discovery.consumeMatchingTranscript([{
      type: 'user',
      uuid: 'provider-visible-prompt',
      timestamp: new Date(10_200).toISOString(),
      message: {
        role: 'user',
        content: prompt,
      },
    } satisfies RawJSONLines])).toBe(true);
  });

  it('consumes attachment-bearing typed user rows whose content is stored as text parts', () => {
    const prompt = [
      'Please review the attached screenshots.',
      '',
      'Focus on the pool detail layout.',
    ].join('\n');
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: prompt, acceptedAtMs: 10_000 });

    expect(discovery.consumeMatchingTranscript([{
      type: 'user',
      uuid: 'provider-visible-attachment-prompt',
      timestamp: new Date(10_200).toISOString(),
      promptSource: 'typed',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'file', path: '/tmp/screenshot.png' } },
        ],
      },
    } satisfies RawJSONLines])).toBe(true);
  });

  it('matches long multiline prompts with attachment text blocks after normalization', () => {
    const transcriptPrompt = [
      'ok great, now as you can see in the screenshots attached we have a few issues:',
      '- first, the hero CTAs on mobile need shorter labels.',
      '- then the mobile vertical parallax block is wrong.',
      '',
      'please analyse all of this based on the current state and rendering.',
      '',
      'also analyse deeper what could be causing mobile performance issue and lags on the page.',
      '',
      'Attachments: open and analyze these files before answering.',
      '[attachments]',
      '- .happier/uploads/messages/ea470cda/01711b9b-mobile_cta_target_design.png (mobile_cta_target_design.png, image/png, 342082 bytes)',
      '- .happier/uploads/messages/ea470cda/0b2c73c9-desktop_horizontal_scroll_wrong.png (desktop_horizontal_scroll_wrong.png, image/png, 366831 bytes)',
      '- .happier/uploads/messages/ea470cda/7c365255-mobile_parallax_block.png (mobile_parallax_block.png, image/png, 262290 bytes)',
      '[/attachments]',
    ].join('\n');
    const recordedPrompt = `  ${transcriptPrompt.replace(/\n/g, '\r\n')}  `;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: recordedPrompt, acceptedAtMs: 10_000 });

    expect(discovery.consumeMatchingTranscript([{
      type: 'user',
      uuid: 'provider-visible-long-attachment-prompt',
      promptId: 'prompt-visible-long-attachment-prompt',
      timestamp: new Date(10_200).toISOString(),
      promptSource: 'typed',
      message: {
        role: 'user',
        content: transcriptPrompt,
      },
    } satisfies RawJSONLines])).toBe(true);
  });

  it('retires discarded correlation through the arbiter before matching an identical replacement', async () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({ acceptedPromptWindowMs: 5_000, nowMs: () => 10_000 });
    let retired = false;
    const prompt = 'identical replacement after discard';
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000, quietPeriodMs: 0,
      injectPrompt: async () => ({ status: 'failed' as const, reason: 'timeout' as const,
        phase: 'after_write_before_enter' as const, duplicateRisk: 'possible' as const, recoverable: true }),
      onInjectionFailure: async () => ({ action: 'claimed_pending_delivery' as const }),
      resolvePromptDeliveryState: () => retired ? 'retired' : 'pending',
      onProviderAcceptancePending: (batch) => { discovery.recordAcceptedPrompt({
        message: batch.message, deliveryIdentity: { localIds: batch.userMessageLocalIds ?? [] },
      }); },
      onPromptAccepted: (batch) => { accepted.push(...(batch.userMessageLocalIds ?? [])); },
      onPromptDeliveryRetired: (batch) => { discovery.forgetRetiredPromptByBatch(batch); },
    });
    try {
      arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
      arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
      await arbiter.enqueueUiMessage({ message: prompt, origin: { kind: 'ui_pending' }, userMessageLocalIds: ['discarded'] });
      await arbiter.drainWhenSafe();
      expect(arbiter.snapshot().terminalCustodyCount).toBe(1);
      retired = true;
      await arbiter.drainWhenSafe();
      discovery.recordAcceptedPrompt({ message: prompt, deliveryIdentity: { localIds: ['replacement'] } });
      const match = discovery.claimMatchingTranscript([{
        type: 'user', uuid: 'replacement-row', timestamp: new Date(10_100).toISOString(),
        message: { role: 'user', content: prompt },
      }]);
      expect(match?.deliveryIdentity).toEqual({ localIds: ['replacement'] });
      expect(accepted).toEqual([]);
    } finally { await arbiter.dispose(); }
  });

  it.each(['user', 'native_queue'] as const)('does not infer a Pending identity from identical unresolved attempts (%s)', (evidenceKind) => {
    let now = 10_000;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({ acceptedPromptWindowMs: 5_000, nowMs: () => now });
    const prompt = 'same text after an ambiguous write';
    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 9_000,
      deliveryIdentity: { localIds: ['ambiguous-predecessor'] },
    });
    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_000,
      deliveryIdentity: { localIds: ['replacement-attempt'] },
    });
    const row = {
      type: 'user', uuid: 'only-provider-row', promptId: 'provider-generated-id',
      timestamp: new Date(10_100).toISOString(),
      message: { role: 'user', content: prompt },
    } satisfies RawJSONLines;

    const sessionId = 'abababab-abab-4bab-8bab-abababababab';
    const rows = evidenceKind === 'user' ? [row] : [
      { type: 'queue-operation', operation: 'enqueue', sessionId, content: prompt, timestamp: new Date(10_050).toISOString() },
      { type: 'queue-operation', operation: 'remove', sessionId, content: prompt, timestamp: new Date(10_075).toISOString() },
      { type: 'attachment', uuid: 'only-queued-row', parentUuid: 'queued-parent', isSidechain: false, sessionId, timestamp: new Date(10_100).toISOString(),
        attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' } } },
    ];
    expect(discovery.findMatchingTranscript(rows)).toBeNull();
    expect(discovery.claimMatchingTranscript(rows)).toBeNull();
    // Retiring one candidate cannot turn already ambiguous evidence into proof for its neighbor.
    expect(discovery.consumeAcceptedPromptByBatch({
      message: prompt, userMessageLocalIds: ['ambiguous-predecessor'],
    })).toBe(true);
    now = 30_001;
    expect(discovery.claimMatchingTranscript(rows)).toBeNull();
    const freshRows = rows.map((entry) => ({ ...entry,
      ...('uuid' in entry ? { uuid: `${entry.uuid}-fresh` } : {}),
      timestamp: new Date(Date.parse(entry.timestamp) + 1_000).toISOString(),
    }));
    expect(discovery.claimMatchingTranscript(freshRows)).toEqual(expect.objectContaining({
      deliveryIdentity: { localIds: ['replacement-attempt'] },
    }));
  });

  it('returns structured transcript evidence for sequential identical prompts', () => {
    const prompt = 'repeat this exact prompt';
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_000,
      deliveryIdentity: { localIds: ['first-local'], userMessageSeq: 11 },
    });

    const first = discovery.claimMatchingTranscript([{
      type: 'user',
      uuid: 'provider-user-first',
      promptId: 'provider-prompt-first',
      timestamp: new Date(10_100).toISOString(),
      message: { role: 'user', content: prompt },
    } satisfies RawJSONLines]);
    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_010,
      deliveryIdentity: { localIds: ['second-local'], userMessageSeq: 12 },
    });
    const second = discovery.claimMatchingTranscript([{
      type: 'user',
      uuid: 'provider-user-second',
      promptId: 'provider-prompt-second',
      timestamp: new Date(10_200).toISOString(),
      message: { role: 'user', content: prompt },
    } satisfies RawJSONLines]);

    expect(first).toEqual(expect.objectContaining({
      transcriptUuid: 'provider-user-first',
      transcriptPromptId: 'provider-prompt-first',
      deliveryIdentity: { localIds: ['first-local'], userMessageSeq: 11 },
    }));
    expect(second).toEqual(expect.objectContaining({
      transcriptUuid: 'provider-user-second',
      transcriptPromptId: 'provider-prompt-second',
      deliveryIdentity: { localIds: ['second-local'], userMessageSeq: 12 },
    }));
  });

  it('does not consume a matching accepted prompt until the caller commits the match', () => {
    const prompt = 'confirm me after the arbiter accepts';
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });
    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_000,
      deliveryIdentity: { localIds: ['local-1'], userMessageSeq: 21 },
    });

    const messages = [{
      type: 'user',
      uuid: 'provider-user-commit-later',
      promptId: 'provider-prompt-commit-later',
      timestamp: new Date(10_100).toISOString(),
      message: { role: 'user', content: prompt },
    } satisfies RawJSONLines];
    const match = discovery.findMatchingTranscript(messages);

    expect(match).toEqual(expect.objectContaining({
      acceptedPromptId: 'accepted-prompt-1',
      transcriptUuid: 'provider-user-commit-later',
    }));
    expect(discovery.findMatchingTranscript(messages)).toEqual(expect.objectContaining({
      acceptedPromptId: 'accepted-prompt-1',
    }));
    expect(discovery.consumeAcceptedPromptMatch(match!)).toBe(true);
    expect(discovery.findMatchingTranscript(messages)).toBeNull();
  });

  it('does not let duplicate transcript ingress consume a second identical accepted prompt', () => {
    const prompt = 'same text seen through duplicate watchers';
    const transcriptRow = {
      type: 'user',
      uuid: 'provider-user-duplicate-ingress',
      promptId: 'provider-prompt-duplicate-ingress',
      timestamp: new Date(10_100).toISOString(),
      message: { role: 'user', content: prompt },
    } satisfies RawJSONLines;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });
    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_000,
      deliveryIdentity: { localIds: ['first-local'], userMessageSeq: 31 },
    });

    const first = discovery.claimMatchingTranscript([transcriptRow]);
    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_010,
      deliveryIdentity: { localIds: ['second-local'], userMessageSeq: 32 },
    });
    const duplicate = discovery.claimMatchingTranscript([transcriptRow]);

    expect(first).toEqual(expect.objectContaining({
      deliveryIdentity: { localIds: ['first-local'], userMessageSeq: 31 },
    }));
    expect(duplicate).toBeNull();
  });

  it('retires a provider-accepted identity so a later identical prompt can still match transcript confirmation', () => {
    const prompt = 'same text with different delivery identities';
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });
    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_000,
      deliveryIdentity: { localIds: ['first-local'], userMessageSeq: 41 },
    });
    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_010,
      deliveryIdentity: { localIds: ['second-local'], userMessageSeq: 42 },
    });

    expect(discovery.consumeAcceptedPromptByBatch({
      message: prompt,
      maxUserMessageSeq: 41,
      userMessageLocalIds: ['first-local'],
    })).toBe(true);

    expect(discovery.claimMatchingTranscript([{
      type: 'user',
      uuid: 'provider-user-after-hook-acceptance',
      promptId: 'provider-prompt-after-hook-acceptance',
      timestamp: new Date(10_100).toISOString(),
      message: { role: 'user', content: prompt },
    } satisfies RawJSONLines])).toEqual(expect.objectContaining({
      deliveryIdentity: { localIds: ['second-local'], userMessageSeq: 42 },
    }));
  });

  it('does not consume command-name-only slash evidence when multiple accepted prompts share the command', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: '/model opus', acceptedAtMs: 10_000 });
    discovery.recordAcceptedPrompt({ message: '/model sonnet', acceptedAtMs: 10_010 });

    expect(discovery.consumeMatchingTranscript([{
      type: 'user',
      uuid: 'command-name-only',
      timestamp: new Date(10_250).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>',
      },
    } satisfies RawJSONLines])).toBe(false);

    const consumeNativeQueuedCommand = (prompt: string, timestampMs: number, uuid: string): boolean => {
      const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const timestamp = new Date(timestampMs).toISOString();
      expect(discovery.consumeMatchingTranscript([{
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp,
        sessionId,
        content: prompt,
      } as unknown as RawJSONLines])).toBe(false);
      expect(discovery.consumeMatchingTranscript([{
        type: 'queue-operation',
        operation: 'remove',
        timestamp: new Date(timestampMs + 5).toISOString(),
        sessionId,
        content: prompt,
      } as unknown as RawJSONLines])).toBe(false);
      return discovery.consumeMatchingTranscript([{
        parentUuid: `parent-${uuid}`,
        isSidechain: false,
        type: 'attachment',
        uuid,
        timestamp,
        sessionId,
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          timestamp,
        },
      } as unknown as RawJSONLines]);
    };

    expect(consumeNativeQueuedCommand('/model opus', 10_300, 'queued-model-opus')).toBe(true);
    expect(consumeNativeQueuedCommand('/model sonnet', 10_320, 'queued-model-sonnet')).toBe(true);
  });
});
