import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, type DeploymentReadTransportV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { DeploymentReviewPreview } = await import('./DeploymentReviewPreview');
const { Item } = await import('@/components/ui/lists/Item');
/** The row itself (its testID also lands on inner hosts, which carry no title). */
const row = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) =>
  screen.findAllByType(Item).find((node) => node.props.testID === testID) ?? null;

const scope = { serverId: 'home', accountId: 'account-owner', projectSourceId: 'source-app' };
const shown = { mounted: true, visible: true, focused: true } as const;

/** The network boundary only: the shared read controller, receipt projection and live-address owner run for real. */
function previewController(input: Readonly<{ attachedDomain: boolean; health: 'up' | 'down'; purpose?: 'preview' | 'standard' }>) {
  const base = createDeploymentEnvironmentDetailV1();
  const linkId = base.environment.runtimeTargetLinkId!;
  const servingId = base.targetLinks.find((row) => row.targetLink.id === linkId)!.targetLink.activeDeploymentId!;
  const purpose = input.purpose ?? 'preview';
  // A preview Environment names its template, repository, pull request and target link (the header schema requires all four).
  const relations = purpose === 'preview' ? { previewTemplateEnvironmentId: 'environment-production', previewRepositoryId: scope.projectSourceId,
    previewPullRequestId: 'pr:12', previewTargetLinkId: linkId } : {};
  const detail = { ...base, environment: createDeploymentEnvironmentHeaderV1({ ...base.environment, serverId: scope.serverId, purpose, ...relations }),
    healthAggregate: { v: 1 as const, environmentId: base.environment.id, targetLinkId: linkId, protection: base.environment.protection,
      status: input.health, n: 1, down: input.health === 'down' ? 1 : 0, degraded: 0, unknown: 0, members: [],
      affectedMachineIds: [], edgeUnreachable: false, authoritativeRecovery: false } };
  const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId }) });
  const domain = { domain: { v: 1 as const, id: 'preview-domain', environmentId: detail.environment.id, targetLinkId: linkId, revision: 1,
    state: 'active' as const, contentArtifactId: 'content-preview-domain', contentHeaderVersion: 1, contentBodyVersion: 1,
    createdByAccountId: scope.accountId, createdAtMs: 1, updatedAtMs: 1 },
    title: 'pr-12.preview.example.test', content: { hostname: 'pr-12.preview.example.test', target: { service: 'app', containerPort: 3000 } } };
  const transport: DeploymentReadTransportV1 = {
    listEnvironments: async () => ({ ok: true, value: { items: [{ environment: detail.environment, title: detail.content.name }], nextCursor: null } }),
    readEnvironment: async () => ({ ok: true, value: detail }),
    listHistory: async () => ({ ok: true, value: { ok: true, items: [serving.deployment], nextCursor: null } }),
    readReceipt: async () => ({ ok: true, value: serving }),
    listDomains: async () => ({ ok: true, value: { items: input.attachedDomain ? [domain] : [], nextCursor: null } }),
  };
  return { controller: createDeploymentReadControllerV1({ scope, transport }), environmentId: detail.environment.id };
}

describe('Review preview (deploy auto-mode U9)', () => {
  it("shows the build preview's address, which opens, and its health from the Environment's own owners", async () => {
    const { controller, environmentId } = previewController({ attachedDomain: true, health: 'up' });
    const open = vi.fn();
    const screen = await renderScreen(<DeploymentReviewPreview controller={controller} environmentId={environmentId}
      demand={shown} onOpenAddress={open} />);
    try {
      await waitForTestEvent(screen.subscribe, () => row(screen, 'project-deployments.review.preview.address'),
        (node) => node?.props.title === 'pr-12.preview.example.test');
      expect(row(screen, 'project-deployments.review.preview.health')?.props.title).toBe(t('projects.deployments.healthUp'));
      await screen.pressByTestIdAsync('project-deployments.review.preview.address');
      expect(open).toHaveBeenCalledWith('https://pr-12.preview.example.test/');
    } finally { await screen.unmount(); controller.retire(); await standardCleanup(); }
  });

  it('says a preview that serves no address is not live, and a failing check as failing, never as healthy', async () => {
    const { controller, environmentId } = previewController({ attachedDomain: false, health: 'down' });
    const open = vi.fn();
    const screen = await renderScreen(<DeploymentReviewPreview controller={controller} environmentId={environmentId}
      demand={shown} onOpenAddress={open} />);
    try {
      await waitForTestEvent(screen.subscribe, () => row(screen, 'project-deployments.review.preview.health'),
        (node) => node?.props.title === t('projects.deployments.healthDown'));
      expect(row(screen, 'project-deployments.review.preview.address')?.props.title).toBe(t('projects.deployments.review.previewNotLive'));
      await screen.pressByTestIdAsync('project-deployments.review.preview.address').catch(() => {});
      expect(open).not.toHaveBeenCalled();
    } finally { await screen.unmount(); controller.retire(); await standardCleanup(); }
  });

  it('shows nothing for an Environment that is not a preview (an ordinary promotion keeps its sheet)', async () => {
    const { controller, environmentId } = previewController({ attachedDomain: true, health: 'up', purpose: 'standard' });
    const screen = await renderScreen(<DeploymentReviewPreview controller={controller} environmentId={environmentId}
      demand={shown} onOpenAddress={vi.fn()} />);
    try {
      const record = controller.acquireEnvironment(environmentId, shown);
      await record.refresh();
      expect(record.getSnapshot().value?.environment.purpose).toBe('standard');
      record.release();
      expect(screen.findByTestId('project-deployments.review.preview')).toBeNull();
    } finally { await screen.unmount(); controller.retire(); await standardCleanup(); }
  });
});
