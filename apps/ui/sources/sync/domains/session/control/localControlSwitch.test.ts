import { describe, expect, it } from 'vitest';
import {
  getSwitchToLocalControlDisabledReason,
  shouldRenderChatTimelineForSession,
  shouldRequestRemoteControlAfterPendingEnqueue,
  shouldOfferSwitchToLocalControl,
} from './localControlSwitch';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';

type LocalControlMetadata = NonNullable<Session['metadata']> & {
  startedFromDaemon?: boolean;
};

const resumeOptions: ResumeCapabilityOptions = {
  allowExperimentalResumeByAgentId: { codex: true, gemini: true },
};

function buildSession(overrides: Partial<Session> = {}): Session {
  const metadata: LocalControlMetadata = {
    path: '/repo',
    host: 'localhost',
    flavor: 'codex',
    codexSessionId: 'codex-session-1',
    startedFromDaemon: false,
  };

  return {
    id: 's1',
    seq: 1,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    activeAt: 0,
    metadata,
    metadataVersion: 1,
    agentState: { controlledByUser: false, requests: null, completedRequests: null },
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    ...overrides,
  };
}

describe('localControlSwitch', () => {
  it('does not request remote control when session is null', () => {
    expect(shouldRequestRemoteControlAfterPendingEnqueue(null)).toBe(false);
  });

  it('requests remote control after pending enqueue when session is controlled by user', () => {
    expect(
      shouldRequestRemoteControlAfterPendingEnqueue({
        presence: 'online',
        agentState: { controlledByUser: true },
      } as Session),
    ).toBe(true);
  });

  it('does not request remote control when session is not controlled by user', () => {
    expect(
      shouldRequestRemoteControlAfterPendingEnqueue({
        presence: 'online',
        agentState: { controlledByUser: false },
      } as Session),
    ).toBe(false);
  });

  it('renders the chat timeline when a session is controlled by user even with no messages yet', () => {
    expect(
      shouldRenderChatTimelineForSession({
        committedMessagesCount: 0,
        pendingMessagesCount: 0,
        controlledByUser: true,
      }),
    ).toBe(true);
  });

  it('renders the chat timeline when the footer must be shown even with no messages yet', () => {
    expect(
      shouldRenderChatTimelineForSession({
        committedMessagesCount: 0,
        pendingMessagesCount: 0,
        controlledByUser: false,
        forceRenderFooter: true,
      }),
    ).toBe(true);
  });

  it('offers switch-to-local only when the session is resumable, machine is online, and agent supports local control', () => {
    const session = buildSession();

    expect(
      shouldOfferSwitchToLocalControl({
        session,
        isMachineOnline: false,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBe(false);

    expect(
      shouldOfferSwitchToLocalControl({
        session,
        isMachineOnline: true,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBe(true);
  });

  it('returns a disabled reason for supported agents when machine is offline', () => {
    expect(
      getSwitchToLocalControlDisabledReason({
        session: buildSession(),
        isMachineOnline: false,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBe('machineOffline');
  });

  it('returns a disabled reason for supported agents when session was started by daemon', () => {
    const session = buildSession({
      metadata: {
        ...(buildSession().metadata as LocalControlMetadata),
        startedFromDaemon: true,
      } as Session['metadata'],
    });

    expect(
      getSwitchToLocalControlDisabledReason({
        session,
        isMachineOnline: true,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBe('daemonStarted');
  });

  it('returns a disabled reason for supported agents when resume support is missing', () => {
    const session = buildSession({
      metadata: {
        ...(buildSession().metadata as LocalControlMetadata),
        codexSessionId: '',
      } as Session['metadata'],
    });

    expect(
      getSwitchToLocalControlDisabledReason({
        session,
        isMachineOnline: true,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBe('resumeUnsupported');
  });

  it('does not offer switch-to-local for agents that do not support local control', () => {
    const session = buildSession({
      metadata: {
        path: '/repo',
        host: 'localhost',
        flavor: 'gemini',
        geminiSessionId: 'gemini-session-1',
      } as Session['metadata'],
    });

    expect(
      shouldOfferSwitchToLocalControl({
        session,
        isMachineOnline: true,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBe(false);
  });

  it('keeps disabled reason null when the session is already under local control', () => {
    const session = buildSession({
      agentState: { controlledByUser: true, requests: null, completedRequests: null },
    });

    expect(
      shouldOfferSwitchToLocalControl({
        session,
        isMachineOnline: true,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBe(false);

    expect(
      getSwitchToLocalControlDisabledReason({
        session,
        isMachineOnline: true,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBeNull();
  });
 
  it('does not offer local-control switch for unknown session flavor', () => {
    const session = buildSession({
      metadata: {
        path: '/repo',
        host: 'localhost',
        flavor: 'unknown-provider',
      } as Session['metadata'],
    });

    expect(
      shouldOfferSwitchToLocalControl({
        session,
        isMachineOnline: true,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBe(false);
    expect(
      getSwitchToLocalControlDisabledReason({
        session,
        isMachineOnline: true,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBeNull();
  });

  it('prefers daemonStarted disabled reason over machineOffline when both apply', () => {
    const session = buildSession({
      metadata: {
        ...(buildSession().metadata as LocalControlMetadata),
        startedFromDaemon: true,
      } as Session['metadata'],
    });

    expect(
      getSwitchToLocalControlDisabledReason({
        session,
        isMachineOnline: false,
        resumeCapabilityOptions: resumeOptions,
      }),
    ).toBe('daemonStarted');
  });
});
