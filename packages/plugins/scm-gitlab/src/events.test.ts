import { describe, expect, it } from 'vitest';
import { normalizeGitlabWebhookDelivery } from './events.js';

const project = { id: 77, path_with_namespace: 'team/widgets' };
const rawBody = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
const normalize = (eventType: string, body: unknown, baseUrl = 'https://gitlab.example/GitLab') =>
  normalizeGitlabWebhookDelivery({ eventType, rawBody: rawBody(body), baseUrl,
    providerDeliveryId: 'delivery-1', receivedAtMs: 1000 });

describe('GitLab deployment Event normalization', () => {
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
      payload: { pullRequest: { id: '123', number: 4, mergeCommitSha: 'c'.repeat(40) } },
    });
    expect(normalize('Merge Request Hook', { project, object_attributes: { ...object_attributes, action: 'update' } })).toBeNull();
    expect(() => normalize('Merge Request Hook', { project, object_attributes: { ...object_attributes, target_project_id: 88 } })).toThrow();
    expect(() => normalize('Push Hook', { project, ref: 'refs/heads/main', before: 'a', after: 'main' })).toThrow();
  });
});
