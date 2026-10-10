import { describe, expect, it } from 'vitest';
import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';

import { describeTriageAgentStatusV1, readTriageEntryAgentStatusV1 } from './agentState.js';

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

describe('the one agent state a list row shows for its linked Sessions', () => {
  const working = state({});
  const permission = state({ sessionId: 'session-b', operational: 'permission_required', runtime: 'waiting',
    workStatus: { bucket: 'needs_you', tone: 'attention', word: 'Permission required' } });
  const ready = state({ sessionId: 'session-c', operational: 'ready', runtime: 'idle',
    workStatus: { bucket: 'finished', tone: 'neutral', word: 'Ready' } });
  const unknown = state({ sessionId: 'session-d', operational: 'none', runtime: 'unknown', lifecycle: 'unknown',
    workStatus: { bucket: 'idle', tone: 'neutral', word: 'Unknown' } });

  it('says the Session that needs the reader before one that is merely working or done', () => {
    expect(readTriageEntryAgentStatusV1([ready, working, permission]))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.permission', tone: 'attention' });
    expect(readTriageEntryAgentStatusV1([ready, working]))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.working', live: true });
  });

  it('keeps the selected attention Session identity beside its words and mark, not another working Agent', () => {
    expect(readTriageEntryAgentStatusV1([
      { ...working, agent: { agentId: 'claude', displayName: 'Claude', brand: { pluginId: 'happier.agent.claude' } } },
      { ...permission, agent: { agentId: 'codex', displayName: 'Codex', brand: { pluginId: 'happier.agent.codex' } } },
    ])).toMatchObject({
      labelKey: 'plugins.triage.surface.detail.agent.needsYou', labelParams: { agent: 'Codex' },
      agent: { agentId: 'codex', brand: { pluginId: 'happier.agent.codex' } },
    });
  });

  it('falls back to the first Session it can describe, and claims nothing for none', () => {
    expect(readTriageEntryAgentStatusV1([unknown, ready]))
      .toMatchObject({ labelKey: 'plugins.triage.surface.detail.agent.ready' });
    expect(readTriageEntryAgentStatusV1([unknown])).toBeNull();
    expect(readTriageEntryAgentStatusV1([])).toBeNull();
  });
});
