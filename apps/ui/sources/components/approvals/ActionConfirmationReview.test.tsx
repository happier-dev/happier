import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { LocalServiceStartApprovalReviewV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installSessionSubagentCommonModuleMocks({
  modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module,
  storage: () =>
    vi.importActual<typeof import('@/sync/domains/state/storage')>(
      '@/sync/domains/state/storage',
    ),
  text: () => vi.importActual<typeof import('@/text')>('@/text'),
});
const { confirmActionReview, hasActionConfirmationReviewFacts } =
  await import('./ActionConfirmationReview');
const { ModalProvider } = await import('@/modal');

afterEach(() => standardCleanup());

const workspace = {
  serverId: 'home',
  machineId: 'devbox',
  workspaceId: 'checkout',
  rootPath: '/src/app',
};
const start = {
  machineId: 'devbox',
  targetId: 'web',
  workspace,
  declaration: {
    workspaceRefId: 'checkout',
    selection: { kind: 'manifest', name: 'web' },
  },
  expectedEffectDigest: 'a'.repeat(64),
};
/** What a receiving Machine carries back for a Restart it cannot present: the exact child it would start. */
const restart = {
  actionId: 'localServices.actions.restartManaged',
  actionArgs: {
    requestId: 'restart',
    action: 'restart_managed',
    target: {
      kind: 'managed_service',
      machineId: 'devbox',
      managedServiceId: 'old',
    },
  },
  preview: {
    hostReviewedChildren: {
      children: [
        {
          action: 'localServices.launcher.start',
          role: 'service.restart.start',
          input: start,
        },
      ],
    },
    hostReviewedContent: {
      serviceStartReview: LocalServiceStartApprovalReviewV1Schema.parse({
        request: start,
        target: workspace,
        reviewedEffectDigest: start.expectedEffectDigest,
        setup: {
          required: false,
          project: { serverId: 'home', projectId: 'project' },
          reviewedEffectDigest: 'b'.repeat(64),
          reviewedEffect: {},
        },
        reviewedEffect: {
          command: { source: { kind: 'command', command: 'serve web' } },
        },
      }),
    },
  },
} as const;

describe('native confirmation of a carried executor review', () => {
  it.each([true, false])(
    'shows the Machine-reviewed start command of a Restart and answers %s from its own decision',
    async (confirms) => {
      expect(hasActionConfirmationReviewFacts(restart)).toBe(true);
      const screen = await renderScreen(<ModalProvider />);
      const answer = confirmActionReview({
        ...restart,
        title: 'Restart web?',
        summary: 'Anything using its address disconnects.',
        confirmLabel: 'Restart',
        irreversible: false,
        serverId: 'home',
      });
      await vi.waitFor(() => expect(screen.getTextContent()).toContain('serve web'));
    await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      await screen.pressByTestIdAsync(
        confirms
          ? 'actions.confirmation-review.decision-approve'
          : 'actions.confirmation-review.decision-reject',
      );
      await expect(answer).resolves.toBe(confirms);
      await screen.unmount();
    },
  );

  it('keeps a summary-only review in the plain confirmation', () => {
    expect(
      hasActionConfirmationReviewFacts({
        actionId: 'machines.setup.updates.apply',
        actionArgs: {},
        preview: { summary: 'Install 53 updates' },
      }),
    ).toBe(false);
  });
});