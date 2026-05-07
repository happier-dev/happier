import { describe, expect, it } from 'vitest';
import {
  shouldRenderChatTimelineForSession,
  shouldRequestRemoteControl,
  shouldRequestRemoteControlAfterPendingEnqueue,
} from './localControlSwitch';
import type { Session } from '@/sync/domains/state/storageTypes';

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

  it('does not request remote control when the CLI auth state is logged out', () => {
    expect(
      shouldRequestRemoteControl({
        presence: 'online',
        agentState: { controlledByUser: true },
      } as Session, 'logged_out'),
    ).toBe(false);
    expect(
      shouldRequestRemoteControlAfterPendingEnqueue({
        presence: 'online',
        agentState: { controlledByUser: true },
      } as Session, 'logged_out'),
    ).toBe(false);
  });

  it('does not request remote control when session is not controlled by user', () => {
    expect(
      shouldRequestRemoteControlAfterPendingEnqueue({
        presence: 'online',
        agentState: { controlledByUser: false },
      } as Session),
    ).toBe(false);
  });

  it('does not request remote control after pending enqueue for shared local attachment', () => {
    expect(
      shouldRequestRemoteControlAfterPendingEnqueue({
        presence: 'online',
        agentState: {
          controlledByUser: false,
          localControl: {
            attached: true,
            topology: 'shared',
            remoteWritable: true,
          },
        },
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

  it('does not render an empty chat timeline just to expose remote-to-local attachment UI', () => {
    expect(
      shouldRenderChatTimelineForSession({
        committedMessagesCount: 0,
        pendingMessagesCount: 0,
        controlledByUser: false,
      }),
    ).toBe(false);
  });
});
