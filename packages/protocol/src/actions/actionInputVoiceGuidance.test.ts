import { describe, expect, it } from 'vitest';

import { getActionInputFieldVoiceNotes, getActionVoiceWorkflowNotes } from './actionInputVoiceGuidance.js';

describe('actionInputVoiceGuidance', () => {
  it('uses backendTargetKeys in backend-selection guidance', () => {
    const fieldNotes = getActionInputFieldVoiceNotes(
      { id: 'subagents.plan.start' },
      { path: 'backendTargetKeys', optionsSourceId: 'execution.backends.enabled' } as any,
    ).join(' ');
    const workflowNotes = getActionVoiceWorkflowNotes('subagents.plan.start').join(' ');

    expect(fieldNotes).toContain('backendTargetKeys');
    expect(fieldNotes).toContain('provider/backend targets');
    expect(fieldNotes).toContain('not as parallelism capacity');
    expect(fieldNotes).not.toContain('backendIds');
    expect(workflowNotes).toContain('backendTargetKeys');
    expect(workflowNotes).toContain('provider/backend targets');
    expect(workflowNotes).not.toContain('backendIds');
  });

  it('describes canonical backend targets and runtime carrier guidance for agents.models.list', () => {
    const backendTargetKeyNotes = getActionInputFieldVoiceNotes(
      { id: 'agents.models.list' },
      { path: 'backendTargetKey' } as any,
    ).join(' ');
    const agentIdNotes = getActionInputFieldVoiceNotes(
      { id: 'agents.models.list' },
      { path: 'agentId' } as any,
    ).join(' ');

    expect(backendTargetKeyNotes).toContain('backend:');
    expect(backendTargetKeyNotes).toContain('acpBackend:');
    expect(agentIdNotes).toContain('listAgentBackends');
  });

  it('guides transcript-reading requests to the semantic transcript action', () => {
    const activityNotes = getActionVoiceWorkflowNotes('session.activity.get').join(' ');
    const recentNotes = getActionVoiceWorkflowNotes('session.messages.recent.get').join(' ');
    const transcriptNotes = getActionInputFieldVoiceNotes(
      { id: 'session.transcript.get' },
      { path: 'sessionId' } as any,
    ).join(' ');

    expect(activityNotes).toContain('getSessionTranscript');
    expect(recentNotes).toContain('getSessionTranscript');
    expect(transcriptNotes).toContain('listSessions');
  });
});
