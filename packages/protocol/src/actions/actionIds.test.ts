import { describe, expect, it } from 'vitest';

import {
  ACTION_ID_FAMILIES_V1,
  ACTION_IDS,
  ActionIdSchema,
} from './actionIds.js';

describe('ActionIdSchema', () => {
  it('accepts known action ids', () => {
    expect(ActionIdSchema.parse('review.start')).toBe('review.start');
    expect(ActionIdSchema.parse('subagents.delegate.start')).toBe('subagents.delegate.start');
    expect(ActionIdSchema.parse('session.open')).toBe('session.open');
    expect(ActionIdSchema.parse('execution.run.start')).toBe('execution.run.start');
    expect(ActionIdSchema.parse('execution.run.wait')).toBe('execution.run.wait');
    expect(ActionIdSchema.parse('prompt_asset.export')).toBe('prompt_asset.export');
    expect(ActionIdSchema.parse('prompt_registry.install')).toBe('prompt_registry.install');
  });

  it('does not accept unknown action ids', () => {
    expect(() => ActionIdSchema.parse('execution.run.stream.start' as any)).toThrow();
  });

  it('exposes the canonical action id groups', () => {
    expect(ACTION_ID_FAMILIES_V1).toEqual({
      discovery: [
        'action.spec.search',
        'action.spec.get',
        'action.options.resolve',
      ],
      session_lifecycle: [
        'session.open',
        'session.fork',
        'session.continue_with_replay',
        'session.rollback',
        'session.handoff',
        'session.handoff.prepare_target',
        'session.handoff.commit',
        'session.handoff.abort',
        'session.handoff.status.get',
        'session.spawn_new',
        'session.spawn_picker',
      ],
      inventory: [
        'paths.list_recent',
        'machines.list',
        'servers.list',
        'review.engines.list',
        'agents.backends.list',
        'agents.models.list',
      ],
      messaging: [
        'session.message.send',
      ],
      session_control: [
        'session.stop',
        'session.title.set',
        'session.model.set',
        'session.permission_mode.set',
        'session.archive',
        'session.unarchive',
        'session.status.get',
        'session.history.get',
        'session.wait.idle',
      ],
      intent_start: [
        'review.start',
        'subagents.plan.start',
        'subagents.delegate.start',
        'voice_agent.start',
      ],
      execution_run_control: [
        'execution.run.start',
        'execution.run.list',
        'execution.run.get',
        'execution.run.send',
        'execution.run.stop',
        'execution.run.action',
        'execution.run.wait',
      ],
      session_targeting: [
        'session.target.primary.set',
        'session.target.tracked.set',
        'session.list',
        'session.activity.get',
        'session.messages.recent.get',
      ],
      session_permissions: [
        'session.permission.respond',
        'session.user_action.answer',
        'session.mode.set',
      ],
      external_sessions: [
        'sessions.external.candidates.list',
        'sessions.external.link.ensure',
        'sessions.external.attach',
        'sessions.external.detach',
        'sessions.external.followPolicy.set',
        'sessions.external.status.get',
        'sessions.external.transcript.page',
        'sessions.external.transcript.readAfter',
        'sessions.external.takeover',
      ],
      voice_controls: [
        'ui.voice_global.reset',
        'ui.voice_agent.teleport',
      ],
      memory: [
        'memory.search',
        'memory.get_window',
        'memory.ensure_up_to_date',
      ],
      prompt_library: [
        'prompt_doc.update',
        'prompt_bundle.update',
        'prompt_asset.export',
        'prompt_registry.install',
      ],
      approvals: [
        'approval.request.create',
        'approval.request.decide',
      ],
      scm_pull_request: [
        'scm.pullRequest.list',
        'scm.pullRequest.get',
        'scm.pullRequest.openOrReuse',
        'scm.pullRequest.openCompose',
        'scm.pullRequest.checkout',
        'scm.pullRequest.prepareWorktree',
        'scm.pullRequest.runStacked',
      ],
      scm_repository: [
        'scm.repository.init',
        'scm.repository.removeIndexLock',
        'scm.hostingRepository.describePublishTargets',
        'scm.hostingRepository.publish',
      ],
    });
  });

  it('flattens the action id groups into the canonical action id list', () => {
    expect(ACTION_IDS).toEqual([
      'action.spec.search',
      'action.spec.get',
      'action.options.resolve',
      'session.open',
      'session.fork',
      'session.continue_with_replay',
      'session.rollback',
      'session.handoff',
      'session.handoff.prepare_target',
      'session.handoff.commit',
      'session.handoff.abort',
      'session.handoff.status.get',
      'session.spawn_new',
      'session.spawn_picker',
      'paths.list_recent',
      'machines.list',
      'servers.list',
      'review.engines.list',
      'agents.backends.list',
      'agents.models.list',
      'session.message.send',
      'session.stop',
      'session.title.set',
      'session.model.set',
      'session.permission_mode.set',
      'session.archive',
      'session.unarchive',
      'session.status.get',
      'session.history.get',
      'session.wait.idle',
      'review.start',
      'subagents.plan.start',
      'subagents.delegate.start',
      'voice_agent.start',
      'execution.run.start',
      'execution.run.list',
      'execution.run.get',
      'execution.run.send',
      'execution.run.stop',
      'execution.run.action',
      'execution.run.wait',
      'session.target.primary.set',
      'session.target.tracked.set',
      'session.list',
      'session.activity.get',
      'session.messages.recent.get',
      'session.permission.respond',
      'session.user_action.answer',
      'session.mode.set',
      'sessions.external.candidates.list',
      'sessions.external.link.ensure',
      'sessions.external.attach',
      'sessions.external.detach',
      'sessions.external.followPolicy.set',
      'sessions.external.status.get',
      'sessions.external.transcript.page',
      'sessions.external.transcript.readAfter',
      'sessions.external.takeover',
      'ui.voice_global.reset',
      'ui.voice_agent.teleport',
      'memory.search',
      'memory.get_window',
      'memory.ensure_up_to_date',
      'prompt_doc.update',
      'prompt_bundle.update',
      'prompt_asset.export',
      'prompt_registry.install',
      'approval.request.create',
      'approval.request.decide',
      'scm.pullRequest.list',
      'scm.pullRequest.get',
      'scm.pullRequest.openOrReuse',
      'scm.pullRequest.openCompose',
      'scm.pullRequest.checkout',
      'scm.pullRequest.prepareWorktree',
      'scm.pullRequest.runStacked',
      'scm.repository.init',
      'scm.repository.removeIndexLock',
      'scm.hostingRepository.describePublishTargets',
      'scm.hostingRepository.publish',
    ]);
  });
});
