import { describe, expect, it } from 'vitest';

import { getActionRequiredServerFeatureId } from './actionRequiredServerFeature.js';

describe('getActionRequiredServerFeatureId', () => {
  it('requires automation for agent navigation, not human sidecar controls', () => {
    for (const id of ['browser.navigate', 'browser.goBack', 'browser.goForward', 'browser.reload', 'browser.stop', 'browser.automation.snapshot']) {
      expect(getActionRequiredServerFeatureId(id)).toBe('browser.automation');
    }
    for (const id of ['browser.view.open', 'browser.control.takeControl', 'browser.control.handBack', 'browser.unknown']) {
      expect(getActionRequiredServerFeatureId(id)).toBeNull();
    }
  });
  it('owns the server feature required by each gated Action family', () => {
    expect(getActionRequiredServerFeatureId('workflow.run.start')).toBe('workflows');
    expect(getActionRequiredServerFeatureId('workflow.definition.get')).toBe('workflows');
    expect(getActionRequiredServerFeatureId('workflow.unknown')).toBeNull();
    expect(getActionRequiredServerFeatureId('session.discussion.list')).toBe('sessions.conversations');
    expect(getActionRequiredServerFeatureId('session.discussion.post')).toBe('sessions.conversations');
    expect(getActionRequiredServerFeatureId('session.board.get')).toBe('sessions.board');
    expect(getActionRequiredServerFeatureId('session.board.item.upsert')).toBe('sessions.board');
    expect(getActionRequiredServerFeatureId('session.board.item.remove')).toBe('sessions.board');
    expect(getActionRequiredServerFeatureId('session.board.layout.update')).toBe('sessions.board');
    expect(getActionRequiredServerFeatureId('teams.credentials.list')).toBe('teams.credentialResources');
    expect(getActionRequiredServerFeatureId('teams.credentials.create')).toBe('teams.credentialResources');
    expect(getActionRequiredServerFeatureId('teams.credentials.externalKeys.list'))
      .toBe('teams.credentialResources.externalApi');
    expect(getActionRequiredServerFeatureId('teams.credentials.externalKeys.create'))
      .toBe('teams.credentialResources.externalApi');
    // Shared Saved Secrets are registered on the Team route app, whose one
    // decision is `teams` — not either credential-resource bit.
    expect(getActionRequiredServerFeatureId('secrets.shared.list')).toBe('teams');
    expect(getActionRequiredServerFeatureId('secrets.shared.update')).toBe('teams');
    expect(getActionRequiredServerFeatureId('teams.list')).toBe('teams');
    expect(getActionRequiredServerFeatureId('teams.invitations.create')).toBe('teams');
    expect(getActionRequiredServerFeatureId('session.follow.set')).toBe('sessions.following');
    expect(getActionRequiredServerFeatureId('session.follow.sources.list')).toBe('sessions.following');
    expect(getActionRequiredServerFeatureId('session.access.grant.set')).toBe('sharing.session');
    expect(getActionRequiredServerFeatureId('session.responsibility.set')).toBe('sharing.session');
    expect(getActionRequiredServerFeatureId('session.public_link.create')).toBe('sharing.public');
    expect(getActionRequiredServerFeatureId('artifact.public_link.create')).toBe('sharing.public');
    expect(getActionRequiredServerFeatureId('machines.pools.create')).toBe('machines.pools');
    expect(getActionRequiredServerFeatureId('sessions.runner.activation.create'))
      .toBe('sessions.ephemeralRunner');
    expect(getActionRequiredServerFeatureId('account.apiTokens.create')).toBeNull();
    expect(getActionRequiredServerFeatureId('session.title.set')).toBeNull();
  });
});
