import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

afterEach(() => vi.restoreAllMocks());
const project = { serverId: 'home', projectId: 'project' };
const value = { project, reviewedEffectDigest: 'reviewed', approvedAtMs: 1 };
const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`;
const context = { surface: 'agent' as const, authority: 'account_automation' as const,
  actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'projects.trust.revoke': ['agent'] } }) };
function executor(credentials = true) {
  return createCliActionExecutorHarness({ token, sessionId: 'cli-global', mode: 'plain', ctx: null,
    serverId: 'home', serverHttpBaseUrl: 'https://home.test', ...(credentials ? { credentials: { token, encryption: null } } : {}) }).executor;
}
function networkBoundary() {
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    expect(url).toBe('https://home.test/v1/account/encryption');
    return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
  });
  return vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
    if (url.endsWith('/list')) return { status: 200, data: { rows: [{ project, revision: 3, content: { t: 'plain', v: value } }] } };
    if (url.endsWith('/read')) return { status: 200, data: { status: 'present', revision: 3, content: { t: 'plain', v: value } } };
    expect(body).toEqual({ project, expectedRevision: 3, content: null });
    return { status: 200, data: { status: 'updated', revision: 4, cursor: 4 } };
  });
}
describe('Project Trust Actions through requester CLI composition', () => {
  it('lists the reviewed revision and revokes exactly that effect through the canonical mode-aware client', async () => {
    const post = networkBoundary();
    const owner = executor();
    expect(await owner.execute('projects.trust.list', {}, context)).toEqual({ ok: true, result: { trust: [{ project, revision: 3, value }] } });
    expect(await owner.execute('projects.trust.revoke', { project, expectedRevision: 2, expectedEffectDigest: 'reviewed' }, context))
      .toEqual({ ok: true, result: { project, status: 'conflict' } });
    expect(post.mock.calls.some(([url]) => url.endsWith('/mutate'))).toBe(false);
    expect(await owner.execute('projects.trust.revoke', { project, expectedRevision: 3, expectedEffectDigest: 'reviewed' }, context))
      .toEqual({ ok: true, result: { project, status: 'removed' } });
  });
  it('refuses missing requester credentials and another Home without reading Trust', async () => {
    const post = networkBoundary();
    expect(await executor(false).execute('projects.trust.list', {}, context)).toMatchObject({ ok: false, errorCode: 'project_trust_access_denied' });
    expect(await executor().execute('projects.trust.list', { project: { ...project, serverId: 'other' } }, context))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(post).not.toHaveBeenCalled();
  });
  it('reports cancellation after a read without misclassifying it as Trust storage failure', async () => {
    const controller = new AbortController();
    const post = networkBoundary();
    post.mockImplementationOnce(async () => {
      controller.abort();
      return { status: 200, data: { rows: [{ project, revision: 3, content: { t: 'plain', v: value } }] } };
    });
    expect(await executor().execute('projects.trust.list', {}, { ...context, signal: controller.signal }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
  });
  it('preserves a confirmed Forget CAS receipt when cancellation arrives after the Account mutation', async () => {
    const controller = new AbortController();
    const post = networkBoundary();
    post.mockImplementation(async (url, body) => {
      if (url.endsWith('/read')) return { status: 200, data: { status: 'present', revision: 3, content: { t: 'plain', v: value } } };
      expect(url).toBe('https://home.test/v1/account/project-trust/mutate');
      expect(body).toEqual({ project, expectedRevision: 3, content: null });
      controller.abort();
      return { status: 200, data: { status: 'updated', revision: 4, cursor: 4 } };
    });
    expect(await executor().execute('projects.trust.revoke', { project, expectedRevision: 3, expectedEffectDigest: 'reviewed' }, { ...context, signal: controller.signal }))
      .toEqual({ ok: true, result: { project, status: 'removed' } });
    expect(post.mock.calls.filter(([url]) => url.endsWith('/mutate'))).toHaveLength(1);
  });
  it('keeps a lost Forget receipt unknown after cancellation rather than declaring that no mutation happened', async () => {
    const controller = new AbortController();
    const post = networkBoundary();
    post.mockImplementation(async (url, body) => {
      if (url.endsWith('/read')) return { status: 200, data: { status: 'present', revision: 3, content: { t: 'plain', v: value } } };
      expect(url).toBe('https://home.test/v1/account/project-trust/mutate');
      expect(body).toEqual({ project, expectedRevision: 3, content: null });
      controller.abort();
      throw Object.assign(new Error('Native transport receipt lost'), { config: { headers: { Authorization: 'Bearer private-transport-token' } } });
    });
    const result = await executor().execute('projects.trust.revoke', { project, expectedRevision: 3, expectedEffectDigest: 'reviewed' }, { ...context, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(JSON.stringify(result)).not.toContain('private-transport-token');
    expect(post.mock.calls.filter(([url]) => url.endsWith('/mutate'))).toHaveLength(1);
  });
});
