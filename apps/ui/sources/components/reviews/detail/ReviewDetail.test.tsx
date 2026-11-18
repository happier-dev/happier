import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
  ReviewFindingsList,
  type ReviewFindingsListRow,
} from './ReviewFindingsList';
import {
  ReviewSubmitPanel,
  type ReviewSubmitResult,
} from './ReviewSubmitPanel';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

const ROWS: readonly ReviewFindingsListRow[] = [
  { rowId: 'nit', severity: 'nit', decision: 'reject' },
  { rowId: 'blocker-a', severity: 'blocker', decision: 'undecided' },
  { rowId: 'high', severity: 'high', decision: 'accept' },
  { rowId: 'blocker-b', severity: 'blocker', decision: 'accept' },
];

describe('ReviewFindingsList', () => {
  it('groups rows by severity, most severe first, and filters them by decision in one press', async () => {
    const screen = await renderScreen(
      <ReviewFindingsList
        rows={ROWS}
        renderRow={(rowId) => <RowProbe rowId={rowId} />}
      />,
    );
    expect(groupOrder(screen)).toEqual(['blocker', 'high', 'nit']);
    expect(screen.findByTestId('row:blocker-a')).not.toBeNull();
    // A decision nobody took offers no filter; the ones taken do.
    expect(screen.findByTestId('review-findings:filter:defer')).toBeNull();
    await screen.pressByTestIdAsync('review-findings:filter:accept');
    expect(groupOrder(screen)).toEqual(['blocker', 'high']);
    expect(screen.findByTestId('row:blocker-a')).toBeNull();
    expect(screen.findByTestId('row:blocker-b')).not.toBeNull();
    await screen.unmount();
  });
});

describe('ReviewSubmitPanel', () => {
  it('sends the chosen verdict with the trimmed summary and keeps both when the send fails', async () => {
    const sent: unknown[] = [];
    let result: ReviewSubmitResult = { ok: false, message: 'Not sent' };
    const screen = await renderScreen(
      <ReviewSubmitPanel
        roundOrdinal={2}
        onCancel={() => undefined}
        onSubmit={async (input) => {
          sent.push(input);
          return result;
        }}
      />,
    );
    await screen.pressByTestIdAsync('review-submit:verdict:request_changes');
    await act(async () => {
      screen.changeTextByTestId('review-submit:body',
        '  Keep the draft when the app closes.  ');
    });
    await screen.pressByTestIdAsync('review-submit:send');
    expect(sent).toEqual([
      {
        verdict: 'request_changes',
        body: 'Keep the draft when the app closes.',
      },
    ]);
    // The failure keeps what the person wrote, so the retry sends the same review.
    expect(screen.findHostByTestId('review-submit:body')?.props.value).toBe(
      '  Keep the draft when the app closes.  ',
    );
    result = { ok: true };
    await screen.pressByTestIdAsync('review-submit:send');
    expect(sent).toHaveLength(2);
    await screen.unmount();
  });

  it('sends no summary when none was written', async () => {
    const sent: unknown[] = [];
    const screen = await renderScreen(
      <ReviewSubmitPanel
        roundOrdinal={1}
        onCancel={() => undefined}
        onSubmit={async (input) => {
          sent.push(input);
          return { ok: true };
        }}
      />,
    );
    await screen.pressByTestIdAsync('review-submit:send');
    expect(sent).toEqual([{ verdict: 'approve', body: undefined }]);
    await screen.unmount();
  });
});

function RowProbe(props: Readonly<{ rowId: string }>) {
  return <RowProbeHost testID={`row:${props.rowId}`} />;
}
const RowProbeHost = 'RowProbe' as unknown as React.ComponentType<{
  testID: string;
}>;

function groupOrder(
  screen: Awaited<ReturnType<typeof renderScreen>>,
): string[] {
  return screen.tree.root
    .findAll(
      (node) =>
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('review-findings:group:') &&
        typeof node.type !== 'string',
    )
    .map((node) =>
      String(node.props.testID).slice('review-findings:group:'.length),
    )
    .filter((value, index, all) => all.indexOf(value) === index);
}
