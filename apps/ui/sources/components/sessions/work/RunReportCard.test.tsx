import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerUpdateV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';

import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { Text } from '@/components/ui/text/Text';

const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storageStore');
const { RunReportCard } = await import('./RunReportCard');
let serverId = '';

const REPORT: WorkerUpdateV1 = {
  v: 1,
  workerKind: 'execution_run',
  workerId: 'run-7',
  ownerState: 'succeeded',
  wake: 'finished',
  headline: 'Background run succeeded',
  result: 'Rounded the cart totals',
  canInspect: false,
  transcriptPointer: {
    kind: 'execution_run',
    sessionId: 'lead',
    runId: 'run-7',
  },
  deliverables: [
    { kind: 'check_outcome', name: 'Cart tests', outcome: 'passed' },
  ],
  nextStep: 'Review the pull request.',
};

function retainReport(update: WorkerUpdateV1, id = 'report-1') {
  storage
    .getState()
    .applyMessages('lead', [
      {
        id,
        seq: 3,
        localId: null,
        createdAt: 30,
        role: 'event',
        isSidechain: false,
        content: { type: 'worker-update', update },
      },
    ]);
}

describe('RunReportCard', () => {
  beforeEach(async () => {
    await account.reset();
    ({ serverId } = await account.restore());
    storage.setState({
      sessions: { lead: createSessionFixture({ id: 'lead', serverId }) },
    });
    account.home.answer(serverId, '/v1/sessions/lead/messages', {
      body: { messages: [], hasMore: false, nextBeforeSeq: null },
    });
  });
  afterEach(async () => {
    await account.reset();
  });

  it('draws the Run report its host Session retained, and the caller fallback until it exists', async () => {
    const screen = await renderScreen(
      <RunReportCard
        serverId={serverId}
        run={{ sessionId: 'lead', runId: 'run-7' }}
        fallback={<Text>Plain report</Text>}
      />,
    );
    try {
      expect(screen.getTextContent()).toContain('Plain report');
      await act(async () => {
        retainReport(REPORT);
      });
      const text = screen.getTextContent();
      expect(text).not.toContain('Plain report');
      expect(text).toContain('Rounded the cart totals');
      expect(text).toContain('Cart tests');
      expect(text).toContain('Review the pull request.');
    } finally {
      await screen.unmount();
    }
  });

  it('keeps the fallback for another Run in the same Session', async () => {
    retainReport({
      ...REPORT,
      workerId: 'run-other',
      transcriptPointer: {
        kind: 'execution_run',
        sessionId: 'lead',
        runId: 'run-other',
      },
    });
    const screen = await renderScreen(
      <RunReportCard
        serverId={serverId}
        run={{ sessionId: 'lead', runId: 'run-7' }}
        fallback={<Text>Plain report</Text>}
      />,
    );
    try {
      expect(screen.getTextContent()).toContain('Plain report');
    } finally {
      await screen.unmount();
    }
  });
});
