import { describe, expect, it } from 'vitest';

import { listVoiceActionBlockSpecs, listVoiceToolActionSpecs } from '@happier-dev/protocol';

import { buildElevenLabsVoiceAgentPrompt, buildLocalVoiceAgentSystemPrompt } from './voiceAgentPrompt.js';

describe('voiceAgentPrompt', () => {
  it('prioritizes discovery and hot-path tools in the ElevenLabs prompt instead of inlining the full catalog', () => {
    const prompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(prompt).toContain('searchActionSpecs');
    expect(prompt).toContain('getActionSpec');
    expect(prompt).toContain('resolveActionOptions');
    expect(prompt).toContain('setSessionMode');
    expect(prompt).toContain('startPlan');
    expect(prompt).toContain('sendSessionMessage');
    expect(prompt).not.toContain('- memoryGetWindow:');
  });

  it('omits disabled voice tool action specs in the ElevenLabs prompt', () => {
    const prompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
      disabledActionIds: ['review.start'],
    } as any);

    const review = listVoiceToolActionSpecs().find((s) => s.id === 'review.start');
    const toolName = review?.bindings?.voiceClientToolName;
    if (typeof toolName === 'string' && toolName.trim().length > 0) {
      expect(prompt).not.toContain(toolName);
    }
  });

  it('prioritizes discovery and hot-path actions in the local voice system prompt instead of inlining the full catalog', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });

    expect(prompt).toContain('VOICE_TOOL_RESULTS_JSON:');
    expect(prompt).toContain('searchActionSpecs');
    expect(prompt).toContain('getActionSpec');
    expect(prompt).toContain('resolveActionOptions');
    expect(prompt).toContain('setSessionMode');
    expect(prompt).toContain('startPlan');
    expect(prompt).not.toContain('- memoryGetWindow:');
  });

  it('omits disabled voice action-block specs in the local voice system prompt', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
      disabledActionIds: ['review.start'],
    } as any);

    const review = listVoiceActionBlockSpecs().find((s) => s.id === 'review.start');
    const toolName = review?.bindings?.voiceClientToolName;
    if (typeof toolName === 'string' && toolName.trim().length > 0) {
      expect(prompt).not.toContain(toolName);
    }
  });

  it('documents discovery workflows and field requirements for complex voice tools', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });

    expect(prompt).toContain('startReview');
    expect(prompt).toContain('searchActionSpecs');
    expect(prompt).toContain('getActionSpec');
    expect(prompt).toContain('resolveActionOptions');
    expect(prompt).toContain('spawnSessionPicker');
    expect(prompt).toContain('listRecentPaths');
    expect(prompt).toContain('listAgentBackends');
    expect(prompt).toContain('listAgentModels');
    expect(prompt).toContain('Use listExecutionRuns to discover runs by title or status before choosing runId internally');
    expect(prompt).toContain('Use getExecutionRun after choosing runId to inspect available actions before choosing actionId internally');
    expect(prompt).toContain('Use listSessions to discover sessions by title before choosing sessionId internally');
    expect(prompt).toContain('Use listMachines to discover machines by label before choosing machineId internally');
  });

  it('includes the same discovery guidance in the ElevenLabs voice prompt', () => {
    const prompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(prompt).toContain('listReviewEngines');
    expect(prompt).toContain('spawnSessionPicker');
    expect(prompt).toContain('listAgentModels');
    expect(prompt).toContain('Use listExecutionRuns to discover runs by title or status before choosing runId internally');
    expect(prompt).toContain('Use listSessions to discover sessions by title before choosing sessionId internally');
  });

  it('keeps memory workflows discoverable without inlining every long-tail tool schema', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });

    expect(prompt).not.toContain('- memoryGetWindow:');
    expect(prompt).toContain('Use memorySearch before calling memoryGetWindow');
    expect(prompt).toContain('Use listMachines before choosing machineId internally');
  });

  it('adds explicit recall guidance only when memory recall is enabled', () => {
    const withMemory = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
      memoryRecallGuidanceEnabled: true,
    });
    const withoutMemory = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
      memoryRecallGuidanceEnabled: false,
    });

    expect(withMemory).toContain('If the user asks what you remember from earlier conversations or decisions');
    expect(withMemory).toContain('use memorySearch first');
    expect(withMemory).toContain('use memoryGetWindow to verify the exact details');
    expect(withoutMemory).not.toContain('If the user asks what you remember from earlier conversations or decisions');
  });

  it('appends extra user prompt blocks to local and ElevenLabs voice prompts', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
      extraSystemAppendBlocks: ['Voice stack block'],
    });
    const elevenLabsPrompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
      extraSystemAppendBlocks: ['Voice stack block'],
    });

    expect(localPrompt).toContain('Voice stack block');
    expect(localPrompt.indexOf('Voice stack block')).toBeGreaterThan(localPrompt.indexOf('Core behavior:'));
    expect(elevenLabsPrompt).toContain('Voice stack block');
    expect(elevenLabsPrompt.indexOf('Voice stack block')).toBeGreaterThan(elevenLabsPrompt.indexOf('Core behavior:'));
  });

  it('tells voice agents to use discovery tools instead of asking the user for opaque ids', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });
    const elevenLabsPrompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('Do not ask the user for opaque internal ids when discovery tools can provide them');
    expect(localPrompt).toContain('When an action accepts a human-readable session title, prefer that session title directly instead of forcing yourself to speak or remember a raw session id');
    expect(localPrompt).toContain('If the user already gave you an exact session title for openSession or setPrimaryActionSession, call that action with sessionTitle first before paging through listSessions');
    expect(localPrompt).toContain('Always include sessionId internally when the action accepts it');
    expect(localPrompt).toContain('Only include arguments you know from the active session');
    expect(localPrompt).toContain('Speak about session titles, machine labels, workspace names, backend names, model labels, and other human-readable labels instead of raw ids');
    expect(localPrompt).toContain('When you know a session title, workspace name, backend name, machine label, or model label, say that explicit human-readable label instead of saying "the current session"');

    expect(elevenLabsPrompt).toContain('Do not ask the user for opaque internal ids when discovery tools can provide them');
    expect(elevenLabsPrompt).toContain('When an action accepts a human-readable session title, prefer that session title directly instead of forcing yourself to speak or remember a raw session id');
    expect(elevenLabsPrompt).toContain('If the user already gave you an exact session title for openSession or setPrimaryActionSession, call that action with sessionTitle first before paging through listSessions');
    expect(elevenLabsPrompt).toContain('Speak about session titles, machine labels, workspace names, backend names, model labels, and other human-readable labels instead of raw ids');
    expect(elevenLabsPrompt).toContain('When you know a session title, workspace name, backend name, machine label, or model label, say that explicit human-readable label instead of saying "the current session"');
  });

  it('tells voice agents to forward coding work via sendSessionMessage and stay terse while waiting', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });
    const elevenLabsPrompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('use sendSessionMessage');
    expect(localPrompt).toContain('Do not repeatedly narrate that you are waiting');
    expect(localPrompt).toContain('Do not add greeting filler like "Hi there"');
    expect(localPrompt).toContain('Do not claim a permission request exists unless a real pending permission or user-action request is present in the current session updates');
    expect(localPrompt).toContain('answerUserActionRequest');
    expect(elevenLabsPrompt).toContain('use sendSessionMessage');
    expect(elevenLabsPrompt).toContain('Do not repeatedly narrate that you are waiting');
    expect(elevenLabsPrompt).toContain('Do not add greeting filler like "Hi there"');
    expect(elevenLabsPrompt).toContain('Do not claim a permission request exists unless a real pending permission or user-action request is present in the current session updates');
    expect(elevenLabsPrompt).toContain('answerUserActionRequest');
  });

  it('tells voice agents to pause tool use while a permission or user-action request is pending', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });
    const elevenLabsPrompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('Do not call discovery tools or send new coding work while a permission or user-action request is pending');
    expect(elevenLabsPrompt).toContain('Do not call discovery tools or send new coding work while a permission or user-action request is pending');
  });

  it('tells voice agents to answer active coding-session questions or option prompts before sending more work', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });
    const elevenLabsPrompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('If the active coding session asks a follow-up question or presents options');
    expect(localPrompt).toContain('answer that question first');
    expect(localPrompt).toContain('before sending more coding work');
    expect(elevenLabsPrompt).toContain('If the active coding session asks a follow-up question or presents options');
    expect(elevenLabsPrompt).toContain('answer that question first');
  });

  it('tells voice agents to summarize tool results in plain language instead of reading raw JSON', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });
    const elevenLabsPrompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('Never read raw JSON, raw tool payloads, or raw ids aloud to the user');
    expect(localPrompt).toContain('Summarize tool results in plain language');
    expect(elevenLabsPrompt).toContain('Never read raw JSON, raw tool payloads, or raw ids aloud to the user');
    expect(elevenLabsPrompt).toContain('Summarize tool results in plain language');
  });

  it('tells voice agents to speak as the assistant directly and inspect with tools before answering codebase questions', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });
    const elevenLabsPrompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('Speak as the coding assistant directly');
    expect(localPrompt).toContain('For codebase questions or actions, use tools first before answering');
    expect(localPrompt).toContain('Do not describe yourself as a coordinator, wrapper, messenger, or separate voice layer');
    expect(elevenLabsPrompt).toContain('Speak as the coding assistant directly');
    expect(elevenLabsPrompt).toContain('For codebase questions or actions, use tools first before answering');
  });

  it('adds a dynamic discovery checklist ahead of the tool catalog', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });
    const elevenLabsPrompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('Discovery checklist:');
    expect(localPrompt).toContain('- Use listAgentBackends before choosing backendTargetKeys internally');
    expect(localPrompt).toContain('- Use listSessions before choosing sessionId internally');
    expect(localPrompt).toContain('- If the exact session title is not in the first listSessions page, continue with its next cursor or use spawnSessionPicker');
    expect(localPrompt).toContain('- Prefer spawnSessionPicker if the user has not already chosen an exact path');
    expect(localPrompt).toContain('- When the user asks to choose a machine or directory in the UI, call spawnSessionPicker instead of only saying you will open it');

    expect(elevenLabsPrompt).toContain('Discovery checklist:');
    expect(elevenLabsPrompt).toContain('- Use listExecutionRuns before choosing runId internally');
    expect(elevenLabsPrompt).toContain('- If the exact session title is not in the first listSessions page, continue with its next cursor or use spawnSessionPicker');
  });

  it('keeps internal ids out of the headline prompt wording', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });
    const elevenLabsPrompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).not.toContain('Active sessionId:');
    expect(localPrompt).toContain('Active coding session (internal tool target)');

    expect(elevenLabsPrompt).not.toContain('Active sessionId (always use this for tool calls):');
    expect(elevenLabsPrompt).toContain('Active coding session (internal tool target)');
  });

  it('omits discovery steps that depend on unavailable tools', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
      disabledActionIds: ['session.spawn_picker', 'workspaces.list_recent', 'paths.list_recent'],
    });

    expect(prompt).not.toContain('Prefer spawnSessionPicker if the user has not already chosen an exact workspace or path');
    expect(prompt).not.toContain('Use listRecentWorkspaces instead of guessing workspace ids');
    expect(prompt).not.toContain('Use listRecentPaths instead of guessing raw paths');
    expect(prompt).toContain('Use listAgentBackends before setting agentId');
  });
});
