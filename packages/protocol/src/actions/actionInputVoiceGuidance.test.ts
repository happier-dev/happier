import { describe, expect, it } from 'vitest';

import { getActionInputFieldVoiceNotes, getActionVoiceWorkflowNotes } from './actionInputVoiceGuidance.js';
import { ActionInputFieldHintSchema, getActionSpec } from './actionSpecs.js';

function declaredField(actionId: Parameters<typeof getActionSpec>[0], path: string) {
  const field = getActionSpec(actionId).inputHints?.fields.find((field) => field.path === path);
  if (!field) throw new Error(`Missing declared input field: ${actionId}.${path}`);
  return field;
}

describe('actionInputVoiceGuidance', () => {
  it('offers backend discovery guidance only while its prerequisite Action is available', () => {
    const field = declaredField('subagents.plan.start', 'backendTargetKeys');
    const enabled = { availableActionIds: ['agents.backends.list'] };
    const disabled = { ...enabled, disabledActionIds: ['agents.backends.list'] };

    expect(getActionInputFieldVoiceNotes({ id: 'subagents.plan.start' }, field, enabled)).not.toEqual([]);
    expect(getActionVoiceWorkflowNotes('subagents.plan.start', enabled)).not.toEqual([]);
    for (const availability of [disabled, { availableActionIds: [] }]) {
      expect(getActionInputFieldVoiceNotes({ id: 'subagents.plan.start' }, field, availability)).toEqual([]);
      expect(getActionVoiceWorkflowNotes('subagents.plan.start', availability)).toEqual([]);
    }
  });

  it('describes canonical backend targets and runtime carrier guidance for agents.models.list', () => {
    const backendTargetKeyNotes = getActionInputFieldVoiceNotes(
      { id: 'agents.models.list' },
      declaredField('agents.models.list', 'backendTargetKey'),
    ).join(' ');
    const agentIdNotes = getActionInputFieldVoiceNotes(
      { id: 'agents.models.list' },
      declaredField('agents.models.list', 'agentId'),
    ).join(' ');

    expect(backendTargetKeyNotes).toContain('backend:');
    expect(backendTargetKeyNotes).toContain('acpBackend:');
    expect(agentIdNotes).toContain('listAgentBackends');
  });

  it('guides canonical Session creation fields without reviving flat spawn vocabulary', () => {
    const targetNotes = getActionInputFieldVoiceNotes(
      { id: 'session.spawn_new' },
      declaredField('session.spawn_new', 'executionTarget.machineId'),
    ).join(' ');
    const directoryNotes = getActionInputFieldVoiceNotes(
      { id: 'session.spawn_new' },
      declaredField('session.spawn_new', 'directory'),
    ).join(' ');
    const agentNotes = getActionInputFieldVoiceNotes(
      { id: 'session.spawn_new' },
      declaredField('session.spawn_new', 'agentTarget'),
    ).join(' ');
    const legacyPathNotes = getActionInputFieldVoiceNotes(
      { id: 'session.spawn_new' },
      ActionInputFieldHintSchema.parse({ path: 'path', title: 'Retired path', widget: 'text' }),
    ).join(' ');

    expect(targetNotes).toContain('listMachines');
    expect(directoryNotes).toContain('listRecentPaths');
    expect(agentNotes).toContain('listAgentBackends');
    expect(legacyPathNotes).toBe('');
  });

  it('guides transcript-reading requests to the semantic transcript action', () => {
    const activityNotes = getActionVoiceWorkflowNotes('session.activity.get').join(' ');
    const recentNotes = getActionVoiceWorkflowNotes('session.messages.recent.get').join(' ');
    const transcriptNotes = getActionInputFieldVoiceNotes(
      { id: 'session.transcript.get' },
      declaredField('session.transcript.get', 'sessionId'),
    ).join(' ');

    expect(activityNotes).toContain('getSessionTranscript');
    expect(recentNotes).toContain('getSessionTranscript');
    expect(transcriptNotes).toContain('listSessions');
  });
});
