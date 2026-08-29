import { describe, expect, it, vi } from 'vitest';

describe('runVoiceAgentTurnWithTools tool-round limit', () => {
  it('returns a bounded-limit disposition without publishing or dispatching the action-bearing ceiling response', async () => {
    const sendTurn = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: 'I will check once.',
        actions: [{ t: 'listAgentBackends', args: {} }],
      })
      .mockResolvedValueOnce({
        assistantText: 'Done. I also changed it.',
        actions: [{ t: 'listAgentBackends', args: {} }],
      });
    const onAssistantTurn = vi.fn();
    const onToolResults = vi.fn();
    const onOutputEvent = vi.fn();
    const stop = vi.fn(async () => {});

    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');
    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'check and change it',
      durableLocalId: 'tool-round-limit-1',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn, stop },
      maxToolRounds: 1,
      onAssistantTurn,
      onToolResults,
      onOutputEvent,
    });

    expect(result).toMatchObject({
      disposition: 'tool_round_limit_reached',
      assistantTurns: ['I will check once.'],
      totalActions: 1,
    });
    expect(result.toolResultBatches).toHaveLength(1);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({ t: 'listAgentBackends', args: {} });
    expect(stop).toHaveBeenCalledWith('voice-hidden-s1');
    expect(onAssistantTurn).toHaveBeenCalledTimes(1);
    expect(onAssistantTurn).not.toHaveBeenCalledWith(expect.objectContaining({
      assistantText: 'Done. I also changed it.',
    }));
    expect(onToolResults).toHaveBeenCalledTimes(1);
    expect(sendTurn.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ onOutputEvent }));
    expect(sendTurn.mock.calls[1]?.[2]).not.toHaveProperty('onOutputEvent');
  });

  it('retires the contaminated provider session before a subsequent user turn', async () => {
    let providerHistory: string[] = [];
    const historyAtSend: string[][] = [];
    const responses = [
      { assistantText: 'I will check.', actions: [{ t: 'listAgentBackends', args: {} }] },
      { assistantText: 'Done. I also changed it.', actions: [{ t: 'listAgentBackends', args: {} }] },
      { assistantText: 'Fresh answer.', actions: [] },
    ];
    const sessions = {
      sendTurn: vi.fn(async () => {
        historyAtSend.push([...providerHistory]);
        const response = responses.shift()!;
        providerHistory.push(response.assistantText);
        return response;
      }),
      stop: vi.fn(async () => {
        providerHistory = [];
      }),
    };

    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');
    await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'first turn',
      durableLocalId: 'tool-round-limit-3',
      voiceAgentSessions: sessions,
      maxToolRounds: 1,
    });
    const followUp = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'next turn',
      durableLocalId: 'tool-round-limit-4',
      voiceAgentSessions: sessions,
      maxToolRounds: 1,
    });

    expect(sessions.stop).toHaveBeenCalledTimes(1);
    expect(historyAtSend[2]).toEqual([]);
    expect(followUp).toMatchObject({
      disposition: 'completed',
      assistantTurns: ['Fresh answer.'],
    });
  });

  it('publishes an actionless terminal answer reached on the final allowed follow-up', async () => {
    const sendTurn = vi
      .fn()
      .mockResolvedValueOnce({ assistantText: 'I will check once.', actions: [{ t: 'listAgentBackends', args: {} }] })
      .mockResolvedValueOnce({ assistantText: 'The check completed.', actions: [] });
    const onAssistantTurn = vi.fn();

    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');
    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'check it',
      durableLocalId: 'tool-round-limit-2',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn },
      maxToolRounds: 1,
      onAssistantTurn,
    });

    expect(result.disposition).toBe('completed');
    expect(result.assistantTurns).toEqual(['I will check once.', 'The check completed.']);
    expect(onAssistantTurn).toHaveBeenLastCalledWith({
      assistantText: 'The check completed.',
      actions: [],
      turnIndex: 1,
    });
  });
});
