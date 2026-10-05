import { describe, expect, it } from 'vitest';
import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';

import { describeTriageAgentStatusV1 } from './agentState.js';

const state = (patch: Partial<SessionStateV1>): SessionStateV1 => ({
  sessionId: 'session-a',
  lifecycle: 'active',
  runtime: 'working',
  operational: 'working',
  workStatus: { bucket: 'working', tone: 'neutral', word: 'Working' },
  pendingPermissions: [],
  ...patch,
});

describe('the live agent status on the story rail', () => {
  it('says a waiting permission first, as the loud fact', () => {
    expect(describeTriageAgentStatusV1(state({ operational: 'permission_required', runtime: 'waiting', workStatus: { bucket: 'needs_you', tone: 'attention', word: 'Permission required' } })))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.permission', tone: 'attention', live: false });
  });

  it('pulses only while the agent is actually working', () => {
    expect(describeTriageAgentStatusV1(state({})))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.working', tone: 'neutral', live: true });
    expect(describeTriageAgentStatusV1(state({ operational: 'ready', runtime: 'idle', workStatus: { bucket: 'finished', tone: 'neutral', word: 'Ready' } })))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.ready', tone: 'neutral', live: false });
  });

  it('names failure, offline and a finished Session in words', () => {
    expect(describeTriageAgentStatusV1(state({ operational: 'failed', lifecycle: 'failed', workStatus: { bucket: 'needs_you', tone: 'danger', word: 'Error' } })))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.failed', tone: 'danger' });
    expect(describeTriageAgentStatusV1(state({ operational: 'none', runtime: 'offline', workStatus: { bucket: 'offline', tone: 'attention', word: 'Offline' } })))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.offline', tone: 'attention' });
    expect(describeTriageAgentStatusV1(state({ operational: 'none', runtime: 'idle', lifecycle: 'archived', workStatus: { bucket: 'idle', tone: 'neutral', word: 'Archived' } })))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.archived', tone: 'neutral' });
  });

  it('claims nothing it cannot read', () => {
    expect(describeTriageAgentStatusV1(state({ operational: 'none', runtime: 'unknown', lifecycle: 'unknown', workStatus: { bucket: 'idle', tone: 'neutral', word: 'Unknown' } })))
      .toBeNull();
  });

  it('keeps the reply story copy without promoting the host idle bucket to attention', () => {
    expect(describeTriageAgentStatusV1(state({ operational: 'pending_input', runtime: 'waiting',
      workStatus: { bucket: 'idle', tone: 'neutral', word: 'Waiting for input' } })))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.input', tone: 'neutral', live: false });
  });

  it('keeps the host Work priority when a completed session is offline or has outstanding reports', () => {
    expect(describeTriageAgentStatusV1(state({ operational: 'ready', runtime: 'offline', workStatus: { bucket: 'offline', tone: 'attention', word: 'Offline' } })))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.offline', tone: 'attention', live: false });
    expect(describeTriageAgentStatusV1(state({ operational: 'ready', runtime: 'idle', workStatus: { bucket: 'idle', tone: 'neutral', word: 'Ready' } })))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.ready', tone: 'neutral', live: false });
  });
});
