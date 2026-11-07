import { describe, expect, it, vi } from 'vitest';
import { publishGithubDeploymentReviewNoticesV1, reconcileGithubDeploymentNoticeFactsV1 } from './deploymentNotices.js';
import { decodeGithubDeploymentReviewLocationV1, encodeGithubDeploymentReviewLocationV1 } from './deploymentReviewProtocol.js';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

const locator = { repositoryId: '77', runId: '81', attempt: '2', environmentId: '42' };
const current = [{ ...locator, environmentName: 'production', eligible: true }];
type NoticeRequest = Parameters<PluginInvocationContext['services']['notifications']['send']>[0];
const pageManifest = { contributes: { ui: {
  views: [{ id: 'deployment-review', container: 'appPage' as const, target: { kind: 'app' as const }, title: 'Deployment review', renderer: 'github-forge-native' }],
  renderers: [{ id: 'github-forge-native', kind: 'reactNative' as const, artifact: 'github-forge-native' }],
} } } satisfies Pick<PluginManifest, 'contributes'>;
const noPageManifest = { ...pageManifest, contributes: { ...pageManifest.contributes, ui: { ...pageManifest.contributes.ui, views: [] } } };

function context(send: ReturnType<typeof vi.fn>) {
  // Notifications are a genuine external host boundary. No internal policy or
  // projection is mocked; C1 decides whether a phone delivery is allowed.
  return { signal: new AbortController().signal, services: { notifications: { send } } } as unknown as PluginInvocationContext;
}

describe('deployment notice destination and semantic publication', () => {
  it('round-trips only an exact repository/run/attempt/environment locator', () => {
    const path = encodeGithubDeploymentReviewLocationV1(locator);
    expect(decodeGithubDeploymentReviewLocationV1(path)).toEqual(locator);
    for (const path of ['repositories/77/runs/81', 'repositories/77/runs/81/attempts/2/environments/042',
      'repositories/77/runs/81/attempts/2/environments/42/other', 'https://github.com/acme/widgets', '../81']) {
      expect(decodeGithubDeploymentReviewLocationV1(path)).toBeNull();
    }
  });

  it('sends nothing without the actual declared app page and renderer', async () => {
    const send = vi.fn();
    for (const manifest of [noPageManifest, {}]) {
      expect(await publishGithubDeploymentReviewNoticesV1({ current, previous: [], manifest, observationId: 'checkpoint:absent', isCurrent: async () => true }, context(send)))
        .toMatchObject({ kind: 'unavailable' });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('retains pending facts and their ordering when the provider only reorders environments', () => {
    const previous = [...current, { ...current[0]!, environmentId: '43', environmentName: 'staging' }];
    expect(reconcileGithubDeploymentNoticeFactsV1(previous, structuredClone([...previous].reverse()))).toBe(previous);
    const changed = reconcileGithubDeploymentNoticeFactsV1(previous, [{ ...previous[1]!, eligible: false }, { ...previous[0]! }]);
    expect(changed[0]).toBe(previous[0]);
    expect(changed[1]).toMatchObject({ environmentId: '43', eligible: false });
  });

  it('publishes an exact approval tap target, then performs zero sends for equal observations', async () => {
    const send = vi.fn(async (_request: NoticeRequest) => ({ deliveries: [], replayed: false }));
    const result = await publishGithubDeploymentReviewNoticesV1({ current, previous: [], manifest: pageManifest, observationId: 'checkpoint:absent', isCurrent: async () => true }, context(send));
    expect(result).toMatchObject({ kind: 'published' });
    expect(send).toHaveBeenCalledOnce();
    const notice = send.mock.calls[0]![0];
    expect(notice).toMatchObject({ categoryId: 'github-deployment-review', type: 'approval', resolved: false,
      page: { pageId: 'deployment-review', subPath: encodeGithubDeploymentReviewLocationV1(locator) } });
    expect(decodeGithubDeploymentReviewLocationV1(notice.page?.subPath)).toEqual(locator);
    for (let refresh = 0; refresh < 5; refresh++) {
      await publishGithubDeploymentReviewNoticesV1({ current: structuredClone(current), previous: current, manifest: pageManifest, observationId: 'checkpoint:1', isCurrent: async () => true }, context(send));
    }
    expect(send).toHaveBeenCalledOnce();
    await publishGithubDeploymentReviewNoticesV1({ current: [], previous: current, manifest: pageManifest, observationId: 'checkpoint:1', isCurrent: async () => true }, context(send));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ itemId: notice.itemId, resolved: true, page: notice.page });
  });

  it('does not publish after placement authority changes, or when a locator is malformed', async () => {
    const send = vi.fn();
    expect(await publishGithubDeploymentReviewNoticesV1({ current, previous: [], manifest: pageManifest, observationId: 'checkpoint:absent', isCurrent: async () => false }, context(send)))
      .toMatchObject({ kind: 'unavailable' });
    expect(await publishGithubDeploymentReviewNoticesV1({ current: [{ ...current[0]!, environmentId: '../42' }], previous: [], manifest: pageManifest, observationId: 'checkpoint:absent', isCurrent: async () => true }, context(send)))
      .toMatchObject({ kind: 'unavailable' });
    expect(await publishGithubDeploymentReviewNoticesV1({ current: [{ ...current[0]!, environmentId: '4'.repeat(10_000) }], previous: [], manifest: pageManifest, observationId: 'checkpoint:absent', isCurrent: async () => true }, context(send)))
      .toMatchObject({ kind: 'unavailable' });
    expect(send).not.toHaveBeenCalled();
  });

  it('uses each existing checkpoint transition identity when eligibility returns to an earlier value', async () => {
    const send = vi.fn(async (_request: NoticeRequest) => ({ deliveries: [], replayed: false }));
    const ineligible = [{ ...current[0]!, eligible: false }];
    for (const [previous, next, observationId] of [[[], current, 'row:absent'], [current, ineligible, 'row:1'], [ineligible, current, 'row:2']] as const) {
      await publishGithubDeploymentReviewNoticesV1({ previous, current: next, observationId, manifest: pageManifest, isCurrent: async () => true }, context(send));
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(send.mock.calls.map(([request]) => request.clientRequestId)).size).toBe(3);
    expect(send.mock.calls.map(([request]) => request.itemId)).toEqual(Array(3).fill(send.mock.calls[0]![0].itemId));
  });
});
