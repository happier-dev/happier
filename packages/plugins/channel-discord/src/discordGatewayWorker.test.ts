import type { PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';
import { describe, expect, it, vi } from 'vitest';

import { ConversationProviderObservationIngestInputV1Schema } from '@happier-dev/channels-protocol/v1';

import { createDiscordIdentifyConcurrency } from './discordGatewayIdentifyConcurrency.js';
import { DISCORD_BASE_GATEWAY_INTENTS, DISCORD_MESSAGE_CONTENT_INTENT } from './discordSetup.js';
import { startDiscordGatewayWorker } from './discordGatewayWorker.js';

function gatewayBot() {
  return {
    gatewayUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
    sessionStartLimit: {
      total: 1_000,
      remaining: 1_000,
      resetAfterMs: 86_400_000,
      maxConcurrency: 1,
    },
  };
}

function socketWithFrames(frames: readonly unknown[], closeCode = 4_004): PluginWebSocketConnection & Readonly<{
  sent: ReturnType<typeof vi.fn>;
}> {
  const pending = [...frames];
  const sent = vi.fn(async () => undefined);
  const close = vi.fn();
  return {
    url: 'wss://gateway.discord.gg/?v=10&encoding=json',
    protocol: '',
    closed: Promise.resolve({ kind: 'remote', code: closeCode, wasClean: true }),
    sent,
    send: sent,
    receive: vi.fn(async () => {
      const frame = pending.shift();
      return frame === undefined
        ? { kind: 'closed' as const, close: { kind: 'remote' as const, code: closeCode, wasClean: true } }
        : { kind: 'text' as const, text: JSON.stringify(frame) };
    }),
    close,
    dispose: vi.fn(async () => undefined),
  };
}

function socketUntilClosed(frames: readonly unknown[]): PluginWebSocketConnection & Readonly<{
  sent: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> {
  const pending = [...frames];
  let resolveBlockedReceive: ((value: Awaited<ReturnType<PluginWebSocketConnection['receive']>>) => void) | null = null;
  const sent = vi.fn(async () => undefined);
  const close = vi.fn(() => {
    resolveBlockedReceive?.({ kind: 'closed', close: { kind: 'local', code: 4_000, wasClean: true } });
    resolveBlockedReceive = null;
  });
  return {
    url: 'wss://gateway.discord.gg/?v=10&encoding=json',
    protocol: '',
    closed: Promise.resolve({ kind: 'local', code: 4_000, wasClean: true }),
    sent,
    send: sent,
    receive: vi.fn(async () => {
      const frame = pending.shift();
      if (frame !== undefined) return { kind: 'text' as const, text: JSON.stringify(frame) };
      return await new Promise<Awaited<ReturnType<PluginWebSocketConnection['receive']>>>((resolve) => {
        resolveBlockedReceive = resolve;
      });
    }),
    close,
    dispose: vi.fn(async () => undefined),
  };
}

function sentGatewayOpcodeCount(
  socket: Readonly<{ sent: ReturnType<typeof vi.fn> }>,
  opcode: number,
): number {
  return socket.sent.mock.calls.filter(([message]) => {
    if (
      typeof message !== 'object'
      || message === null
      || !('kind' in message)
      || message.kind !== 'text'
      || !('text' in message)
      || typeof message.text !== 'string'
    ) {
      return false;
    }
    try {
      return JSON.parse(message.text).op === opcode;
    } catch {
      return false;
    }
  }).length;
}

describe('Discord Gateway worker', () => {
  it('keeps an attempted pre-READY Identify inside Discord\'s five-second window when the host socket records the payload then rejects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let markFirstIdentifySent!: () => void;
      const firstIdentifySent = new Promise<void>((resolve) => { markFirstIdentifySent = resolve; });
      let markSecondSocketOpened!: () => void;
      const secondSocketOpened = new Promise<void>((resolve) => { markSecondSocketOpened = resolve; });
      const firstSocket = socketWithFrames([{ op: 10, d: { heartbeat_interval: 60_000 } }], 4_000);
      firstSocket.sent.mockImplementationOnce(async () => {
        markFirstIdentifySent();
        throw new Error('Host socket rejected after accepting the Identify payload.');
      });
      const secondSocket = socketUntilClosed([{ op: 10, d: { heartbeat_interval: 60_000 } }]);
      const oneRemainingStart = {
        gatewayUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
        sessionStartLimit: {
          total: 1_000,
          remaining: 1,
          resetAfterMs: 86_400_000,
          maxConcurrency: 1,
        },
      };
      const openWebSocket = vi.fn(async () => {
        if (openWebSocket.mock.calls.length === 1) return firstSocket;
        markSecondSocketOpened();
        return secondSocket;
      });
      const getGatewayBot = vi.fn(async () => oneRemainingStart);
      const worker = startDiscordGatewayWorker({
        connection: {
          connectionId: 'connection-identify-window',
          authorityEpoch: 8,
          applicationId: 'application-1',
          botUserId: 'bot-1',
          token: 'bot-token',
          runtime: { requiresFullSharedMessageContent: false },
          applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
        },
        api: { getGatewayBot, getChannel: vi.fn(), getGuildMember: vi.fn(async () => null) },
        webSockets: { openWebSocket },
        admitObservation: vi.fn(),
        signal: new AbortController().signal,
        identifyConcurrency: createDiscordIdentifyConcurrency(),
      });

      await firstIdentifySent;
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await secondSocketOpened;
      await vi.advanceTimersByTimeAsync(0);

      expect(getGatewayBot).toHaveBeenCalledTimes(2);
      expect(sentGatewayOpcodeCount(secondSocket, 2)).toBe(0);

      await vi.advanceTimersByTimeAsync(3_999);
      expect(sentGatewayOpcodeCount(secondSocket, 2)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(sentGatewayOpcodeCount(secondSocket, 2)).toBe(1);

      worker.stop();
      await expect(worker.result).resolves.toEqual({ kind: 'stopped' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases an Identify reservation when cancellation wins before the socket send boundary', async () => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController();
      const gate = createDiscordIdentifyConcurrency();
      const socket = socketWithFrames([{ op: 10, d: { heartbeat_interval: 60_000 } }]);
      const identifyConcurrency = {
        async acquire(input: Readonly<{
          applicationId: string;
          maxConcurrency: number;
          signal: AbortSignal;
        }>) {
          const permit = await gate.acquire(input);
          parent.abort(new Error('Discord Gateway generation retired before Identify send.'));
          return permit;
        },
      };
      const worker = startDiscordGatewayWorker({
        connection: {
          connectionId: 'connection-identify-cancelled-before-send',
          authorityEpoch: 8,
          applicationId: 'application-1',
          botUserId: 'bot-1',
          token: 'bot-token',
          runtime: { requiresFullSharedMessageContent: false },
          applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
        },
        api: { getGatewayBot: vi.fn(async () => gatewayBot()), getChannel: vi.fn(), getGuildMember: vi.fn(async () => null) },
        webSockets: { openWebSocket: vi.fn(async () => socket) },
        admitObservation: vi.fn(),
        signal: parent.signal,
        identifyConcurrency,
      });

      await expect(worker.result).resolves.toEqual({ kind: 'stopped' });
      expect(socket.sent).not.toHaveBeenCalled();

      let nextGranted = false;
      const next = gate.acquire({
        applicationId: 'application-1',
        maxConcurrency: 1,
        signal: new AbortController().signal,
      }).then((permit) => {
        nextGranted = true;
        return permit;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(nextGranted).toBe(true);
      (await next).release();
    } finally {
      await vi.advanceTimersByTimeAsync(5_000);
      vi.useRealTimers();
    }
  });

  it('uses the host WebSocket, current Gateway Bot facts, current provider role proof, and core admission without a checkpoint', async () => {
    const socket = socketWithFrames([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 1,
        t: 'READY',
        d: {
          session_id: 'session-1',
          resume_gateway_url: 'wss://gateway.discord.gg/?v=10&encoding=json',
        },
      },
      {
        op: 0,
        s: 2,
        t: 'GUILD_CREATE',
        d: {
          id: 'guild-1',
          members: [{ user: { id: 'bot-1' }, roles: ['role-before-message'] }],
        },
      },
      {
        op: 0,
        s: 3,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-1',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 0,
          content: 'hello through a role mention',
          author: { id: 'human-1', bot: false },
          mention_roles: ['role-1'],
          attachments: [],
          embeds: [],
        },
      },
      {
        op: 0,
        s: 4,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-role-revoked-1',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          timestamp: '2024-01-01T00:01:00.000Z',
          type: 0,
          content: 'the Gateway role snapshot is stale',
          author: { id: 'human-2', bot: false },
          mention_roles: ['role-before-message'],
          attachments: [],
          embeds: [],
        },
      },
      {
        op: 0,
        s: 5,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-automation-result-1',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          timestamp: '2024-01-01T00:02:00.000Z',
          type: 0,
          content: 'Automation result delivered back to Discord',
          author: { id: 'bot-1', bot: true },
          attachments: [],
          embeds: [],
        },
      },
    ]);
    const openWebSocket = vi.fn(async () => socket);
    const getGatewayBot = vi.fn(async () => gatewayBot());
    const getChannel = vi.fn(async () => ({ channelId: 'channel-1', kind: 'shared' as const }));
    const getGuildMember = vi.fn()
      .mockResolvedValueOnce({ roleIds: ['role-1'] })
      .mockResolvedValueOnce({ roleIds: [] });
    const admitObservation = vi.fn(async (input: unknown) => {
      ConversationProviderObservationIngestInputV1Schema.parse(input);
    });
    const api = { getGatewayBot, getChannel, getGuildMember };

    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-1',
        authorityEpoch: 7,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: true },
        applicationMessageContentIntentPermission: { kind: 'enabled', source: 'flagsAndFlagsNew' },
      },
      api,
      webSockets: { openWebSocket },
      admitObservation,
      signal: new AbortController().signal,
    });

    await expect(worker.result).resolves.toEqual({ kind: 'terminal', reason: 'authenticationFailed' });
    expect(getGatewayBot).toHaveBeenCalledTimes(1);
    expect(openWebSocket).toHaveBeenCalledWith(
      { url: 'wss://gateway.discord.gg/?v=10&encoding=json' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(socket.sent).toHaveBeenCalledWith(
      {
        kind: 'text',
        text: JSON.stringify({
          op: 2,
          d: {
            token: 'bot-token',
            intents: DISCORD_BASE_GATEWAY_INTENTS | DISCORD_MESSAGE_CONTENT_INTENT,
            properties: { os: 'happier', browser: 'happier', device: 'happier' },
          },
        }),
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getChannel).toHaveBeenCalledWith(
      { channelId: 'channel-1' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getGuildMember).toHaveBeenCalledWith(
      { guildId: 'guild-1', userId: 'bot-1' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getGuildMember).toHaveBeenCalledTimes(2);
    expect(admitObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'connection-1',
        entry: expect.objectContaining({
          eventCandidate: {
            eventRef: {
              pluginId: 'happier.channel.discord',
              localId: 'automation/channel-message-observed-v1',
            },
            sourceInstanceId: 'discord:application:application-1:channel:channel-1',
            sourceContractVersion: 1,
            payload: {
              v: 1,
              channelId: 'channel-1',
              channelKind: 'shared',
              messageId: 'message-1',
              text: 'hello through a role mention',
              textTruncated: false,
              addressingEvidence: 'integrationRoleMention',
              contentProvenance: 'original',
              actorKind: 'human',
              actorPrincipalId: 'discord:user:human-1',
            },
          },
          observation: expect.objectContaining({
            kind: 'fullText',
            observation: expect.objectContaining({
              occurrenceId: 'discord:message:message-1',
              transport: { kind: 'socket' },
              endpoint: expect.objectContaining({
                kind: 'shared',
                audience: 'shared',
                id: 'discord:channel:channel-1',
              }),
              message: expect.objectContaining({ addressingEvidence: 'integrationRoleMention' }),
            }),
          }),
        }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const admissionInput = admitObservation.mock.calls[0]?.[0];
    expect(admissionInput).not.toHaveProperty('entry.observation.observation.streamKey');
    expect(admissionInput).not.toHaveProperty('checkpointTransition');
    expect(admitObservation.mock.calls[1]?.[0]).toMatchObject({
      entry: {
        eventCandidate: {
          eventRef: {
            pluginId: 'happier.channel.discord',
            localId: 'automation/channel-message-observed-v1',
          },
          sourceInstanceId: 'discord:application:application-1:channel:channel-1',
          sourceContractVersion: 1,
          payload: {
            messageId: 'message-role-revoked-1',
            addressingEvidence: 'none',
          },
        },
        observation: {
          kind: 'fullText',
          observation: {
            occurrenceId: 'discord:message:message-role-revoked-1',
            message: { addressingEvidence: 'none' },
          },
        },
      },
    });
    expect(admitObservation.mock.calls[2]?.[0]).toMatchObject({
      entry: {
        eventCandidate: null,
        observation: {
          kind: 'fullText',
          observation: {
            occurrenceId: 'discord:message:message-automation-result-1',
            actor: {
              principalId: 'discord:user:bot-1',
              kind: 'bot',
              isIntegrationSelf: true,
            },
            message: {
              id: 'message-automation-result-1',
              text: 'Automation result delivered back to Discord',
            },
          },
        },
      },
    });
  });

  it('keeps a retained Message Content Identify intent active for replayed shared messages before RESUMED', async () => {
    const immediateClock = {
      now: () => Date.now(),
      setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      sleep: async () => undefined,
    };
    const firstSocket = socketWithFrames([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 1,
        t: 'READY',
        d: {
          session_id: 'session-replay-content',
          resume_gateway_url: 'wss://gateway.discord.gg/?v=10&encoding=json',
        },
      },
    ], 4_000);
    const resumedSocket = socketWithFrames([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 2,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-before-resumed',
          channel_id: 'channel-replay-content',
          guild_id: 'guild-replay-content',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 0,
          content: 'the retained intent makes this replayed shared body available',
          author: { id: 'human-replay-content', bot: false },
          attachments: [],
          embeds: [],
        },
      },
      { op: 0, s: 3, t: 'RESUMED', d: {} },
    ]);
    const openWebSocket = vi.fn(async () => (
      openWebSocket.mock.calls.length === 1 ? firstSocket : resumedSocket
    ));
    const admitObservation = vi.fn(async (input: unknown) => {
      ConversationProviderObservationIngestInputV1Schema.parse(input);
    });
    const reportReadiness = vi.fn();
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-replay-content',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: true },
        applicationMessageContentIntentPermission: { kind: 'enabled', source: 'flagsAndFlagsNew' },
      },
      api: {
        getGatewayBot: vi.fn(async () => gatewayBot()),
        getChannel: vi.fn(async () => ({ channelId: 'channel-replay-content', kind: 'shared' as const })),
        getGuildMember: vi.fn(async () => null),
      },
      webSockets: { openWebSocket },
      admitObservation,
      signal: new AbortController().signal,
      clock: immediateClock,
      reportReadiness,
    });

    await expect(worker.result).resolves.toEqual({ kind: 'terminal', reason: 'authenticationFailed' });
    expect(resumedSocket.sent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'text', text: expect.stringContaining('"op":6') }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(admitObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: {
          eventCandidate: expect.objectContaining({
            eventRef: {
              pluginId: 'happier.channel.discord',
              localId: 'automation/channel-message-observed-v1',
            },
            sourceInstanceId: 'discord:application:application-1:channel:channel-replay-content',
            sourceContractVersion: 1,
            payload: expect.objectContaining({
              messageId: 'message-before-resumed',
              text: 'the retained intent makes this replayed shared body available',
            }),
          }),
          observation: {
            kind: 'fullText',
            observation: expect.objectContaining({
              occurrenceId: 'discord:message:message-before-resumed',
              message: expect.objectContaining({
                text: 'the retained intent makes this replayed shared body available',
                addressingEvidence: 'none',
              }),
            }),
          },
        },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(reportReadiness).toHaveBeenCalledTimes(2);
  });

  it('settles an incumbent admission before a resumed socket can admit later product data', async () => {
    const immediateClock = {
      now: () => Date.now(),
      setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      sleep: async () => undefined,
    };
    const firstSocket = socketUntilClosed([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 1,
        t: 'READY',
        d: {
          session_id: 'session-admission-drain',
          resume_gateway_url: 'wss://gateway.discord.gg/?v=10&encoding=json',
        },
      },
      {
        op: 0,
        s: 2,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-incumbent-a',
          channel_id: 'channel-incumbent-a',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 0,
          content: 'A',
          author: { id: 'human-a', bot: false },
          mentions: [{ id: 'bot-1' }],
          attachments: [],
          embeds: [],
        },
      },
    ]);
    const secondSocket = socketUntilClosed([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      { op: 0, s: 3, t: 'RESUMED', d: {} },
      {
        op: 0,
        s: 4,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-later-b',
          channel_id: 'channel-later-b',
          timestamp: '2024-01-01T00:00:01.000Z',
          type: 0,
          content: 'B',
          author: { id: 'human-b', bot: false },
          mentions: [{ id: 'bot-1' }],
          attachments: [],
          embeds: [],
        },
      },
    ]);
    const openWebSocket = vi.fn(async () => (
      openWebSocket.mock.calls.length === 1 ? firstSocket : secondSocket
    ));
    let markIncumbentAdmissionStarted!: () => void;
    const incumbentAdmissionStarted = new Promise<void>((resolve) => { markIncumbentAdmissionStarted = resolve; });
    let rejectIncumbentAdmission!: (reason: Error) => void;
    const incumbentAdmission = new Promise<void>((_resolve, reject) => { rejectIncumbentAdmission = reject; });
    let releaseLaterChannelLookup!: () => void;
    const laterChannelLookup = new Promise<void>((resolve) => { releaseLaterChannelLookup = resolve; });
    let laterChannelLookupStarted = false;
    const getChannel = vi.fn(async ({ channelId }: Readonly<{ channelId: string }>) => {
      if (channelId === 'channel-later-b') {
        laterChannelLookupStarted = true;
        await laterChannelLookup;
      }
      return { channelId, kind: 'direct' as const };
    });
    const admitObservation = vi.fn(async (input: unknown) => {
      const admission = ConversationProviderObservationIngestInputV1Schema.parse(input);
      const occurrenceId = admission.entry.observation.kind === 'fullText'
        ? admission.entry.observation.observation.occurrenceId
        : admission.entry.observation.shell.occurrenceId;
      if (occurrenceId === 'discord:message:message-incumbent-a') {
        markIncumbentAdmissionStarted();
        await incumbentAdmission;
      }
    });
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-admission-drain',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: { getGatewayBot: vi.fn(async () => gatewayBot()), getChannel, getGuildMember: vi.fn(async () => null) },
      webSockets: { openWebSocket },
      admitObservation,
      signal: new AbortController().signal,
      clock: immediateClock,
    });

    await incumbentAdmissionStarted;
    await vi.waitFor(() => expect(firstSocket.receive).toHaveBeenCalledTimes(4));
    firstSocket.close({ code: 4_000, reason: 'force reconnect with A unsettled' });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    expect(laterChannelLookupStarted).toBe(false);

    releaseLaterChannelLookup();
    rejectIncumbentAdmission(new Error('A could not be admitted.'));

    await expect(worker.result).resolves.toEqual({ kind: 'historyGap', reason: 'applicationAdmissionLost' });
    expect(admitObservation).toHaveBeenCalledTimes(1);
    expect(getChannel).not.toHaveBeenCalledWith(
      { channelId: 'channel-later-b' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not admit resumed product data after an incumbent current role read fails', async () => {
    const immediateClock = {
      now: () => Date.now(),
      setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      sleep: async () => undefined,
    };
    const firstSocket = socketUntilClosed([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 1,
        t: 'READY',
        d: {
          session_id: 'session-role-proof-drain',
          resume_gateway_url: 'wss://gateway.discord.gg/?v=10&encoding=json',
        },
      },
      {
        op: 0,
        s: 2,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-role-proof-a',
          channel_id: 'channel-role-proof-a',
          guild_id: 'guild-role-proof',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 0,
          content: 'A role proof must settle before resumed product data',
          author: { id: 'human-a', bot: false },
          mention_roles: ['role-1'],
          attachments: [],
          embeds: [],
        },
      },
    ]);
    const secondSocket = socketUntilClosed([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      { op: 0, s: 3, t: 'RESUMED', d: {} },
      {
        op: 0,
        s: 4,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-role-proof-b',
          channel_id: 'channel-role-proof-b',
          timestamp: '2024-01-01T00:00:01.000Z',
          type: 0,
          content: 'B must not begin after A has a typed role-proof failure',
          author: { id: 'human-b', bot: false },
          mentions: [{ id: 'bot-1' }],
          attachments: [],
          embeds: [],
        },
      },
    ]);
    const openWebSocket = vi.fn(async () => (
      openWebSocket.mock.calls.length === 1 ? firstSocket : secondSocket
    ));
    let markRoleReadStarted!: () => void;
    const roleReadStarted = new Promise<void>((resolve) => { markRoleReadStarted = resolve; });
    let releaseRoleRead!: () => void;
    const roleRead = new Promise<void>((resolve) => { releaseRoleRead = resolve; });
    let laterChannelLookupStarted = false;
    const getChannel = vi.fn(async ({ channelId }: Readonly<{ channelId: string }>) => {
      if (channelId === 'channel-role-proof-b') laterChannelLookupStarted = true;
      return { channelId, kind: channelId === 'channel-role-proof-a' ? 'shared' as const : 'direct' as const };
    });
    const getGuildMember = vi.fn(async () => {
      markRoleReadStarted();
      await roleRead;
      return { kind: 'notReady' as const, reason: 'network' as const };
    });
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-role-proof-drain',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: { getGatewayBot: vi.fn(async () => gatewayBot()), getChannel, getGuildMember },
      webSockets: { openWebSocket },
      admitObservation: vi.fn(async () => undefined),
      signal: new AbortController().signal,
      clock: immediateClock,
    });

    await roleReadStarted;
    await vi.waitFor(() => expect(firstSocket.receive).toHaveBeenCalledTimes(4));
    firstSocket.close({ code: 4_000, reason: 'force reconnect with role proof unsettled' });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    expect(laterChannelLookupStarted).toBe(false);

    releaseRoleRead();

    await expect(worker.result).resolves.toEqual({
      kind: 'notReady',
      failure: { kind: 'notReady', reason: 'network' },
      transportFact: { kind: 'historyGap', reason: 'applicationAdmissionLost' },
    });
    expect(laterChannelLookupStarted).toBe(false);
  });

  it('returns each current role-lookup failure without treating it as an absent bot role set', async () => {
    const failures = [
      {
        name: 'rate limit',
        failure: {
          kind: 'notReady' as const,
          reason: 'rateLimited' as const,
          retryAfterMs: 1_250,
          diagnostic: 'You are being rate limited.',
        },
      },
      {
        name: 'permission refusal',
        failure: {
          kind: 'notReady' as const,
          reason: 'permissionMissing' as const,
          diagnostic: 'Missing Access',
        },
      },
      {
        name: 'network failure',
        failure: {
          kind: 'notReady' as const,
          reason: 'network' as const,
        },
      },
    ] as const;

    for (const { name, failure } of failures) {
      const socket = socketWithFrames([
        { op: 10, d: { heartbeat_interval: 60_000 } },
        {
          op: 0,
          s: 1,
          t: 'READY',
          d: {
            session_id: `session-role-failure-${failure.reason}`,
            resume_gateway_url: 'wss://gateway.discord.gg/?v=10&encoding=json',
          },
        },
        {
          op: 0,
          s: 2,
          t: 'MESSAGE_CREATE',
          d: {
            id: `message-role-failure-${failure.reason}`,
            channel_id: `channel-role-failure-${failure.reason}`,
            guild_id: 'guild-role-failure',
            timestamp: '2024-01-01T00:00:00.000Z',
            type: 0,
            content: 'a role mention must not become false none',
            author: { id: 'human-role-failure', bot: false },
            mention_roles: ['role-1'],
            attachments: [],
            embeds: [],
          },
        },
      ]);
      const admitObservation = vi.fn(async () => undefined);
      const worker = startDiscordGatewayWorker({
        connection: {
          connectionId: `connection-role-failure-${failure.reason}`,
          authorityEpoch: 8,
          applicationId: 'application-1',
          botUserId: 'bot-1',
          token: 'bot-token',
          runtime: { requiresFullSharedMessageContent: false },
          applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
        },
        api: {
          getGatewayBot: vi.fn(async () => gatewayBot()),
          getChannel: vi.fn(async () => ({
            channelId: `channel-role-failure-${failure.reason}`,
            kind: 'shared' as const,
          })),
          getGuildMember: vi.fn(async () => failure),
        },
        webSockets: { openWebSocket: vi.fn(async () => socket) },
        admitObservation,
        signal: new AbortController().signal,
      });

      await expect(worker.result, name).resolves.toEqual({
        kind: 'notReady',
        failure,
        transportFact: { kind: 'historyGap', reason: 'applicationAdmissionLost' },
      });
      expect(admitObservation, name).not.toHaveBeenCalled();
    }
  });

  it('treats an authoritative absent bot member as lost current role evidence', async () => {
    const socket = socketWithFrames([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 1,
        t: 'READY',
        d: {
          session_id: 'session-role-member-absent',
          resume_gateway_url: 'wss://gateway.discord.gg/?v=10&encoding=json',
        },
      },
      {
        op: 0,
        s: 2,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-role-member-absent',
          channel_id: 'channel-role-member-absent',
          guild_id: 'guild-role-member-absent',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 0,
          content: 'an absent bot member is not an empty role set',
          author: { id: 'human-role-member-absent', bot: false },
          mention_roles: ['role-1'],
          attachments: [],
          embeds: [],
        },
      },
    ]);
    const admitObservation = vi.fn(async () => undefined);
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-role-member-absent',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: {
        getGatewayBot: vi.fn(async () => gatewayBot()),
        getChannel: vi.fn(async () => ({ channelId: 'channel-role-member-absent', kind: 'shared' as const })),
        getGuildMember: vi.fn(async () => null),
      },
      webSockets: { openWebSocket: vi.fn(async () => socket) },
      admitObservation,
      signal: new AbortController().signal,
    });

    await expect(worker.result).resolves.toEqual({
      kind: 'notReady',
      failure: {
        kind: 'notReady',
        reason: 'permissionMissing',
        diagnostic: 'Discord did not confirm the current bot as a member of the guild for role mention evidence.',
      },
      transportFact: { kind: 'historyGap', reason: 'applicationAdmissionLost' },
    });
    expect(admitObservation).not.toHaveBeenCalled();
  });

  it('submits an authenticated bodyless edit refusal to the core Action without inventing a checkpoint', async () => {
    const socket = socketWithFrames([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 2,
        t: 'MESSAGE_UPDATE',
        d: {
          id: 'message-edit-1',
          channel_id: 'channel-edit-1',
          timestamp: '2024-01-01T00:00:00.000Z',
          edited_timestamp: '2024-01-01T00:01:00.000Z',
          type: 0,
          content: 'the edit body must not cross the ingress boundary',
          author: { id: 'human-edit-1', bot: false },
          mentions: [{ id: 'bot-1' }],
        },
      },
    ]);
    const admitObservation = vi.fn(async (input: unknown) => {
      ConversationProviderObservationIngestInputV1Schema.parse(input);
    });
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-edit-1',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: {
        getGatewayBot: vi.fn(async () => gatewayBot()),
        getChannel: vi.fn(async () => ({ channelId: 'channel-edit-1', kind: 'shared' as const })),
        getGuildMember: vi.fn(async () => null),
      },
      webSockets: { openWebSocket: vi.fn(async () => socket) },
      admitObservation,
      signal: new AbortController().signal,
    });

    await expect(worker.result).resolves.toEqual({ kind: 'terminal', reason: 'authenticationFailed' });
    expect(admitObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'connection-edit-1',
        entry: {
          eventCandidate: null,
          observation: {
            kind: 'routableNonAdmission',
            reason: 'unsupportedEdit',
            shell: expect.objectContaining({
              occurrenceId: 'discord:message:message-edit-1:edit:2024-01-01T00:01:00.000Z',
              transport: { kind: 'socket' },
              endpoint: expect.objectContaining({ id: 'discord:channel:channel-edit-1' }),
              actor: expect.objectContaining({ principalId: 'discord:user:human-edit-1' }),
              message: {
                id: 'message-edit-1',
                revision: '2024-01-01T00:01:00.000Z',
                addressingEvidence: 'directIntegrationMention',
                contentProvenance: 'original',
                providerTimestamp: Date.parse('2024-01-01T00:00:00.000Z'),
              },
            }),
          },
        },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const admissionInput = admitObservation.mock.calls[0]?.[0];
    expect(admissionInput).not.toHaveProperty('entry.observation.shell.streamKey');
    expect(admissionInput).not.toHaveProperty('checkpointTransition');
  });

  it('keeps an unroutable delete out of the admission lane instead of reporting a false history gap', async () => {
    const socket = socketWithFrames([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 2,
        t: 'MESSAGE_DELETE',
        d: { id: 'message-delete-1', channel_id: 'channel-delete-1' },
      },
    ]);
    const getChannel = vi.fn(async () => {
      throw new Error('An unroutable delete must not resolve an endpoint.');
    });
    const admitObservation = vi.fn(async () => undefined);
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-delete-1',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: { getGatewayBot: vi.fn(async () => gatewayBot()), getChannel, getGuildMember: vi.fn(async () => null) },
      webSockets: { openWebSocket: vi.fn(async () => socket) },
      admitObservation,
      signal: new AbortController().signal,
    });

    await expect(worker.result).resolves.toEqual({ kind: 'terminal', reason: 'authenticationFailed' });
    expect(getChannel).not.toHaveBeenCalled();
    expect(admitObservation).not.toHaveBeenCalled();
  });

  it('closes promptly and returns a truthful application-admission history gap instead of reconnecting after core admission fails', async () => {
    const socket = socketUntilClosed([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 2,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-2',
          channel_id: 'channel-2',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 0,
          content: 'hello bot',
          author: { id: 'human-2', bot: false },
          mentions: [{ id: 'bot-1' }],
          attachments: [],
          embeds: [],
        },
      },
    ]);
    const openWebSocket = vi.fn(async () => socket);
    const getGatewayBot = vi.fn(async () => gatewayBot());
    const getChannel = vi.fn(async () => ({ channelId: 'channel-2', kind: 'direct' as const }));
    const getGuildMember = vi.fn(async () => null);
    const admitObservation = vi.fn(async () => {
      throw new Error('Channels core authority is unavailable.');
    });

    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-2',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: { getGatewayBot, getChannel, getGuildMember },
      webSockets: { openWebSocket },
      admitObservation,
      signal: new AbortController().signal,
    });

    await expect(worker.result).resolves.toEqual({ kind: 'historyGap', reason: 'applicationAdmissionLost' });
    expect(socket.close).toHaveBeenCalled();
    expect(openWebSocket).toHaveBeenCalledTimes(1);
    expect(getGatewayBot).toHaveBeenCalledTimes(1);
    expect(getGuildMember).not.toHaveBeenCalled();
    expect(socket.sent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'text',
        text: expect.stringContaining(`\"intents\":${DISCORD_BASE_GATEWAY_INTENTS}`),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns an application-admission history gap when a received dispatch is cancelled before its core admission settles', async () => {
    const parent = new AbortController();
    const socket = socketUntilClosed([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 2,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-replacement',
          channel_id: 'channel-replacement',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 0,
          content: 'hello bot',
          author: { id: 'human-replacement', bot: false },
          mentions: [{ id: 'bot-1' }],
          attachments: [],
          embeds: [],
        },
      },
    ]);
    let admissionStarted!: () => void;
    const admissionStartedPromise = new Promise<void>((resolve) => { admissionStarted = resolve; });
    const admitObservation = vi.fn(async (_input: unknown, options: Readonly<{ signal: AbortSignal }>) => {
      admissionStarted();
      await new Promise<void>((_resolve, reject) => {
        if (options.signal.aborted) {
          reject(options.signal.reason);
          return;
        }
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    });
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-replacement',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: {
        getGatewayBot: vi.fn(async () => gatewayBot()),
        getChannel: vi.fn(async () => ({ channelId: 'channel-replacement', kind: 'direct' as const })),
        getGuildMember: vi.fn(async () => null),
      },
      webSockets: { openWebSocket: vi.fn(async () => socket) },
      admitObservation,
      signal: parent.signal,
    });

    await admissionStartedPromise;
    parent.abort(new Error('Discord Gateway strict demand changed.'));
    worker.stop();

    await expect(worker.result).resolves.toEqual({ kind: 'historyGap', reason: 'applicationAdmissionLost' });
    expect(admitObservation).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalled();
  });

  it('stops when a received admission fulfills after cancellation', async () => {
    const parent = new AbortController();
    const socket = socketUntilClosed([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 2,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-cancellation-settled',
          channel_id: 'channel-cancellation-settled',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 0,
          content: 'hello bot',
          author: { id: 'human-cancellation-settled', bot: false },
          mentions: [{ id: 'bot-1' }],
          attachments: [],
          embeds: [],
        },
      },
    ]);
    let admissionStarted!: () => void;
    const admissionStartedPromise = new Promise<void>((resolve) => { admissionStarted = resolve; });
    let settleAdmission!: () => void;
    const admissionSettledPromise = new Promise<void>((resolve) => { settleAdmission = resolve; });
    const admitObservation = vi.fn(async () => {
      admissionStarted();
      await admissionSettledPromise;
    });
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-cancellation-settled',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: {
        getGatewayBot: vi.fn(async () => gatewayBot()),
        getChannel: vi.fn(async () => ({ channelId: 'channel-cancellation-settled', kind: 'direct' as const })),
        getGuildMember: vi.fn(async () => null),
      },
      webSockets: { openWebSocket: vi.fn(async () => socket) },
      admitObservation,
      signal: parent.signal,
    });

    await admissionStartedPromise;
    parent.abort(new Error('Discord Gateway strict demand changed.'));
    worker.stop();
    settleAdmission();

    await expect(worker.result).resolves.toEqual({ kind: 'stopped' });
    expect(admitObservation).toHaveBeenCalledTimes(1);
  });

  it('prefers application-admission loss when a pending admission rejects during terminal outer teardown', async () => {
    const parent = new AbortController();
    const frames = [
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 2,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-terminal-teardown',
          channel_id: 'channel-terminal-teardown',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 0,
          content: 'hello bot',
          author: { id: 'human-terminal-teardown', bot: false },
          mentions: [{ id: 'bot-1' }],
          attachments: [],
          embeds: [],
        },
      },
    ];
    let emitTerminalClose!: () => void;
    const terminalClose = new Promise<Awaited<ReturnType<PluginWebSocketConnection['receive']>>>((resolve) => {
      emitTerminalClose = () => resolve({
        kind: 'closed',
        close: { kind: 'remote', code: 4_004, wasClean: true },
      });
    });
    let markDisposeStarted!: () => void;
    const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve; });
    let releaseDispose!: () => void;
    const disposeReleased = new Promise<void>((resolve) => { releaseDispose = resolve; });
    const socket: PluginWebSocketConnection = {
      url: 'wss://gateway.discord.gg/?v=10&encoding=json',
      protocol: '',
      closed: Promise.resolve({ kind: 'remote', code: 4_004, wasClean: true }),
      send: vi.fn(async () => undefined),
      receive: vi.fn(async () => {
        const frame = frames.shift();
        return frame === undefined
          ? await terminalClose
          : { kind: 'text' as const, text: JSON.stringify(frame) };
      }),
      close: vi.fn(),
      dispose: vi.fn(async () => {
        markDisposeStarted();
        await disposeReleased;
      }),
    };
    let markAdmissionStarted!: () => void;
    const admissionStarted = new Promise<void>((resolve) => { markAdmissionStarted = resolve; });
    let rejectAdmission!: (error: Error) => void;
    const heldAdmission = new Promise<void>((_resolve, reject) => { rejectAdmission = reject; });
    const admitObservation = vi.fn(async () => {
      markAdmissionStarted();
      await heldAdmission;
    });
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-terminal-teardown',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: {
        getGatewayBot: vi.fn(async () => gatewayBot()),
        getChannel: vi.fn(async () => ({ channelId: 'channel-terminal-teardown', kind: 'direct' as const })),
        getGuildMember: vi.fn(async () => null),
      },
      webSockets: { openWebSocket: vi.fn(async () => socket) },
      admitObservation,
      signal: parent.signal,
    });

    await admissionStarted;
    emitTerminalClose();
    await disposeStarted;
    releaseDispose();
    // Let the terminal result leave the socket loop and enter its outer
    // teardown, where it is waiting for the held admission to settle.
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    parent.abort(new Error('Discord Gateway outer teardown started.'));
    rejectAdmission(new Error('Channels admission rejected during teardown.'));

    await expect(worker.result).resolves.toEqual({ kind: 'historyGap', reason: 'applicationAdmissionLost' });
    expect(admitObservation).toHaveBeenCalledTimes(1);
  });

  it('stops without a history gap when no received admission is pending', async () => {
    const socket = socketUntilClosed([{ op: 10, d: { heartbeat_interval: 60_000 } }]);
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-clean-stop',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: {
        getGatewayBot: vi.fn(async () => gatewayBot()),
        getChannel: vi.fn(),
        getGuildMember: vi.fn(async () => null),
      },
      webSockets: { openWebSocket: vi.fn(async () => socket) },
      admitObservation: vi.fn(),
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(socket.sent).toHaveBeenCalledTimes(1));
    worker.stop();

    await expect(worker.result).resolves.toEqual({ kind: 'stopped' });
  });

  it('does not open a Gateway socket or silently downgrade when strict core demand lacks Developer Portal permission', async () => {
    const getGatewayBot = vi.fn(async () => gatewayBot());
    const openWebSocket = vi.fn(async () => {
      throw new Error('A Message Content preflight failure must not open a Gateway socket.');
    });

    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-3',
        authorityEpoch: 9,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: true },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flagsAndFlagsNew' },
      },
      api: { getGatewayBot, getChannel: vi.fn(), getGuildMember: vi.fn(async () => null) },
      webSockets: { openWebSocket },
      admitObservation: vi.fn(),
      signal: new AbortController().signal,
    });

    await expect(worker.result).resolves.toEqual({
      kind: 'messageContentIntentRecoveryRequired',
      source: 'applicationFlags',
      coreDemand: true,
      applicationPermission: 'disabled',
      gatewayIntentRequested: false,
      gatewayIntentActive: false,
      failure: {
        kind: 'notReady',
        reason: 'permissionMissing',
        // The four Message Content facts C7 keeps distinct travel to the user
        // through this one diagnostic. A bare sentence tells a person that
        // something is wrong but not which of the four switches to flip.
        diagnostic: 'Discord Message Content must be enabled for this application in the Developer Portal.'
          + ' Message Content status: required by this connection: yes;'
          + ' application permission: disabled;'
          + ' Gateway intent requested: no;'
          + ' Gateway intent active: no.',
      },
    });
    expect(getGatewayBot).not.toHaveBeenCalled();
    expect(openWebSocket).not.toHaveBeenCalled();
  });

  it('reports a typed Message Content recovery after Gateway close 4014 instead of treating a requested intent as active', async () => {
    const socket = socketWithFrames([
      { op: 10, d: { heartbeat_interval: 60_000 } },
    ], 4_014);
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-4',
        authorityEpoch: 10,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: true },
        applicationMessageContentIntentPermission: { kind: 'enabled', source: 'flagsAndFlagsNew' },
      },
      api: { getGatewayBot: vi.fn(async () => gatewayBot()), getChannel: vi.fn(), getGuildMember: vi.fn(async () => null) },
      webSockets: { openWebSocket: vi.fn(async () => socket) },
      admitObservation: vi.fn(),
      signal: new AbortController().signal,
    });

    await expect(worker.result).resolves.toEqual({
      kind: 'messageContentIntentRecoveryRequired',
      source: 'gateway4014',
      coreDemand: true,
      applicationPermission: 'enabled',
      gatewayIntentRequested: true,
      gatewayIntentActive: false,
      failure: {
        kind: 'notReady',
        reason: 'permissionMissing',
        // The Developer Portal says enabled and the Identify did request the
        // intent, yet Discord refused it. Only the four distinct facts make
        // that difference visible instead of looking like the case above.
        diagnostic: 'Discord refused the requested Message Content intent (Gateway close 4014).'
          + ' Message Content status: required by this connection: yes;'
          + ' application permission: enabled;'
          + ' Gateway intent requested: yes;'
          + ' Gateway intent active: no.',
      },
    });
    expect(socket.sent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'text',
        text: expect.stringContaining(`\"intents\":${DISCORD_BASE_GATEWAY_INTENTS | DISCORD_MESSAGE_CONTENT_INTENT}`),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('canonicalizes a bare READY resume URL and fails closed instead of opening an unadmitted resume origin', async () => {
    const immediateClock = {
      now: () => Date.now(),
      setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      sleep: async () => undefined,
    };
    const firstSocket = socketWithFrames([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 1,
        t: 'READY',
        d: {
          session_id: 'session-bare-resume-url',
          resume_gateway_url: 'wss://gateway.discord.gg',
        },
      },
    ], 4_000);
    const resumedSocket = socketWithFrames([{ op: 10, d: { heartbeat_interval: 60_000 } }], 4_004);
    const openWebSocket = vi.fn(async () => openWebSocket.mock.calls.length === 1 ? firstSocket : resumedSocket);
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-bare-resume-url',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: { getGatewayBot: vi.fn(async () => gatewayBot()), getChannel: vi.fn(), getGuildMember: vi.fn(async () => null) },
      webSockets: { openWebSocket },
      admitObservation: vi.fn(),
      signal: new AbortController().signal,
      clock: immediateClock,
    });

    await expect(worker.result).resolves.toEqual({ kind: 'terminal', reason: 'authenticationFailed' });
    expect(openWebSocket).toHaveBeenNthCalledWith(
      2,
      { url: 'wss://gateway.discord.gg/?v=10&encoding=json' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const invalidResumeSocket = socketWithFrames([
      { op: 10, d: { heartbeat_interval: 60_000 } },
      {
        op: 0,
        s: 1,
        t: 'READY',
        d: {
          session_id: 'session-unadmitted-resume-url',
          resume_gateway_url: 'wss://unadmitted.example/discord',
        },
      },
    ], 4_000);
    const invalidOpenWebSocket = vi.fn(async () => {
      if (invalidOpenWebSocket.mock.calls.length === 1) return invalidResumeSocket;
      throw new Error('The generic host must not be asked to admit an untrusted Discord resume URL.');
    });
    const invalidWorker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-unadmitted-resume-url',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: { getGatewayBot: vi.fn(async () => gatewayBot()), getChannel: vi.fn(), getGuildMember: vi.fn(async () => null) },
      webSockets: { openWebSocket: invalidOpenWebSocket },
      admitObservation: vi.fn(),
      signal: new AbortController().signal,
      clock: immediateClock,
    });

    await expect(invalidWorker.result).resolves.toEqual({ kind: 'historyGap', reason: 'providerHistoryUnavailable' });
    expect(invalidOpenWebSocket).toHaveBeenCalledTimes(1);
  });

  it('backs off inside the reconnect bounds the Gateway session emitted and restarts the ramp after a healthy session', async () => {
    // Discord re-identifies an Invalid Session inside a 1-5s window while a
    // generic reconnect ramps to 30s, so the worker must use the bounds the
    // session emitted for the disconnect it is reacting to. A session that
    // reached READY/RESUMED is healthy: the next disconnect must not inherit
    // the ramp that preceded it.
    const sleeps: number[] = [];
    const clock = {
      now: () => 0,
      setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      sleep: async (delayMs: number) => { sleeps.push(delayMs); },
    };
    const hello = { op: 10, d: { heartbeat_interval: 60_000 } };
    const resumableInvalidSession = { op: 9, d: true };
    const sockets = [
      socketUntilClosed([
        hello,
        {
          op: 0,
          s: 1,
          t: 'READY',
          d: { session_id: 'session-backoff', resume_gateway_url: 'wss://gateway.discord.gg/' },
        },
        resumableInvalidSession,
      ]),
      socketUntilClosed([hello, resumableInvalidSession]),
      socketUntilClosed([hello, resumableInvalidSession]),
      socketUntilClosed([hello, resumableInvalidSession]),
      socketUntilClosed([hello, { op: 0, s: 5, t: 'RESUMED', d: {} }, resumableInvalidSession]),
      socketWithFrames([], 4_004),
    ];
    const openWebSocket = vi.fn(async () => {
      const socket = sockets.shift();
      if (!socket) throw new Error('The worker opened more Gateway sockets than this scenario supplies.');
      return socket;
    });
    const worker = startDiscordGatewayWorker({
      connection: {
        connectionId: 'connection-reconnect-bounds',
        authorityEpoch: 8,
        applicationId: 'application-1',
        botUserId: 'bot-1',
        token: 'bot-token',
        runtime: { requiresFullSharedMessageContent: false },
        applicationMessageContentIntentPermission: { kind: 'disabled', source: 'flags' },
      },
      api: {
        getGatewayBot: vi.fn(async () => gatewayBot()),
        getChannel: vi.fn(),
        getGuildMember: vi.fn(async () => null),
      },
      webSockets: { openWebSocket },
      admitObservation: vi.fn(),
      signal: new AbortController().signal,
      clock,
    });

    await expect(worker.result).resolves.toEqual({ kind: 'terminal', reason: 'authenticationFailed' });
    // Cycles 1-4 ramp inside the Invalid Session ceiling (the generic ceiling
    // would have produced 8_000 on the fourth); the RESUMED session restarts
    // the ramp (the unreset ramp would have produced 16_000).
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 5_000, 1_000]);
  });
});
