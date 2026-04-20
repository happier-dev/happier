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
    expect(fieldNotes).not.toContain('backendIds');
    expect(workflowNotes).toContain('backendTargetKeys');
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
});
