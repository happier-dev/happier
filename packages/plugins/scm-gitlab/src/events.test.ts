import { describe, expect, it } from 'vitest';
import { normalizeGitlabWebhookDelivery } from './events.js';
import { gitlabRepositoryEventSourceInstanceId } from '@happier-dev/plugin-sdk/scm';

const project = { id: 77, path_with_namespace: 'team/widgets' };
const rawBody = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
const normalize = (eventType: string, body: unknown, baseUrl = 'https://gitlab.example/GitLab') =>
  normalizeGitlabWebhookDelivery({ eventType, rawBody: rawBody(body), baseUrl,
    providerDeliveryId: 'delivery-1', receivedAtMs: 1000 });

describe('GitLab deployment Event normalization', () => {
  it.each([
    ['open', 'opened', undefined], ['reopen', 'reopened', undefined], ['update', 'synchronize', 'a'.repeat(40)],
  ] as const)('pins the reviewable %s occurrence to its MR author and exact source head', (action, expectedAction, oldrev) => {
    // GitLab's user is the webhook actor; author_id is the MR author. oldrev identifies code updates.
    // https://docs.gitlab.com/user/project/integrations/webhook_events/#merge-request-events
    const object_attributes = { id: 123, iid: 4, action, state: 'opened', author_id: 12,
      source_project_id: 88, target_project_id: 77, source_branch: 'feature', target_branch: 'main',
      source: { id: 88, path_with_namespace: 'contributor/widgets' }, last_commit: { id: 'b'.repeat(40) },
      ...(oldrev === undefined ? {} : { oldrev }) };
    expect(normalize('Merge Request Hook', { project, user: { id: 99, username: 'maintainer' }, object_attributes })).toMatchObject({
      eventRef: { pluginId: 'happier.scm.forge.gitlab', localId: 'automation/pull-request-lifecycle-v1' },
      sourceInstanceId: gitlabRepositoryEventSourceInstanceId('https://gitlab.example/GitLab', '77'),
      occurrenceId: 'delivery-1', occurredAtMs: 1000,
      payload: { repository: { repositoryId: '77', nameWithOwner: 'team/widgets', baseUrl: 'https://gitlab.example/GitLab' },
        pullRequest: { id: '123', number: 4, action: expectedAction, headSha: 'b'.repeat(40), headRef: 'feature', baseRef: 'main',
          baseRepository: { kind: 'gitlab', deployment: 'https://gitlab.example/GitLab', repository: 'team/widgets' },
          headRepository: { kind: 'gitlab', deployment: 'https://gitlab.example/GitLab', repository: 'contributor/widgets' },
          author: { id: '12', login: null, kind: 'unsupported' }, authorAssociation: 'unknown' },
        reviewTarget: {
          lastKnownLocator: { v: 1, routingToken: 'team/widgets' },
          entryRef: { source: { pluginId: 'happier.scm.forge.gitlab', localId: 'gitlab-forge' }, kindId: 'merge-request',
            collisionScope: gitlabRepositoryEventSourceInstanceId('https://gitlab.example/GitLab', '77'), entryId: '4' },
          comparisonSource: { kind: 'pullRequest', locator: { providerId: 'gitlab',
            repository: 'https://gitlab.example/GitLab/team/widgets', number: 4, headOid: 'b'.repeat(40) } },
        } },
    });
  });

  it('ignores metadata-only updates and pins the target project before admitting review work', () => {
    const object_attributes = { id: 123, iid: 4, action: 'update', state: 'opened', target_project_id: 77 };
    expect(normalize('Merge Request Hook', { project, object_attributes })).toBeNull();
    expect(() => normalize('Merge Request Hook', { project,
      object_attributes: { ...object_attributes, oldrev: 'a'.repeat(40), target_project_id: 88 } })).toThrow();
  });

  it('pins push range and the configured deployment, without trusting payload URLs or commit summaries', () => {
    const payload = { project: { ...project, web_url: 'https://other.example/team/widgets' },
      ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40), commits: [] };
    const event = normalize('Push Hook', payload)!;
    expect(event).toMatchObject({ eventRef: { pluginId: 'happier.scm.forge.gitlab', localId: 'automation/repository-pushed-v1' },
      payload: { repository: { repositoryId: '77', nameWithOwner: 'team/widgets', baseUrl: 'https://gitlab.example/GitLab' },
        before: 'a'.repeat(40), after: 'b'.repeat(40) } });
    expect(normalize('Push Hook', payload)).toEqual(event);
    expect(normalize('Push Hook', payload, 'https://gitlab.example/Other')?.sourceInstanceId).not.toBe(event.sourceInstanceId);
    expect(normalize('Tag Push Hook', payload)).toBeNull();
  });

  it('emits only completed merges at their immutable merge commit', () => {
    const object_attributes = { id: 123, iid: 4, action: 'merge', state: 'merged', target_project_id: 77,
      merge_commit_sha: 'c'.repeat(40) };
    expect(normalize('Merge Request Hook', { project, object_attributes })).toMatchObject({
      eventRef: { localId: 'automation/pull-request-merged-v1' },
      payload: { pullRequest: { id: '123', number: 4, mergeCommitSha: 'c'.repeat(40), authorAssociation: 'unknown' } },
    });
    expect(normalize('Merge Request Hook', { project, object_attributes: { ...object_attributes, action: 'update' } })).toBeNull();
    expect(() => normalize('Merge Request Hook', { project, object_attributes: { ...object_attributes, target_project_id: 88 } })).toThrow();
    expect(() => normalize('Push Hook', { project, ref: 'refs/heads/main', before: 'a', after: 'main' })).toThrow();
  });
});
