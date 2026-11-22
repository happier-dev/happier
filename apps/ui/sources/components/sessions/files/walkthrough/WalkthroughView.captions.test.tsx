import * as React from 'react';
import { expect, it, vi } from 'vitest';

import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import type { ScmDiffSummaryWalkthrough } from '@happier-dev/protocol/scm/diffSummary';

import { buildWalkthroughReading } from './walkthroughReading';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
// The recycler has no measured viewport in the test renderer: its boundary mock draws the first rows, the code view's
// rows and lane stay real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
  return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(), renderItemLimit: 40, emitViewability: false }).module;
});

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { WalkthroughView } = await import('./WalkthroughView');

const PATH = 'labels.txt';
// Two hunks in the file; the captioned stop reads only the second one, so its card renumbers that hunk.
const DIFF =
  [
    `diff --git a/${PATH} b/${PATH}`,
    `--- a/${PATH}`,
    `+++ b/${PATH}`,
    '@@ -1,2 +1,2 @@',
    ' fixture: walkthrough',
    '-owner: none',
    '+owner: qa',
    '@@ -20,3 +20,3 @@',
    ' section: labels',
    '-staging: off',
    '+staging: preview only',
    ' end: true',
  ].join('\n') + '\n';

const COMPARISON: ScmComparison = {
  id: 'walkthrough-captions',
  source: { kind: 'session', sessionId: 'captions-session' },
  repository: { rootPath: '/repo' },
  endpoints: { before: 'b0', after: 'a0' },
  inventory: {
    state: 'complete',
    reasons: [],
    files: [
      {
        path: PATH,
        changeKind: 'modified',
        binary: false,
        generated: false,
        lockfile: false,
        evidence: { state: 'available', unifiedDiff: DIFF },
        occurrences: [
          {
            id: 'owner-0',
            alias: 'c1',
            path: PATH,
            position: 0,
            before: { startLine: 1, lineCount: 2 },
            after: { startLine: 1, lineCount: 2 },
          },
          {
            id: 'staging-1',
            alias: 'c2',
            path: PATH,
            position: 1,
            before: { startLine: 20, lineCount: 3 },
            after: { startLine: 20, lineCount: 3 },
          },
        ],
      },
    ],
  },
};

const WALKTHROUGH: ScmDiffSummaryWalkthrough = {
  title: 'Review the fixture labels',
  intro: 'Two label changes.',
  otherChangeRefs: [],
  stops: [
    {
      id: 'owner',
      title: 'Name the owner',
      explanationMarkdown: 'The owner label names the QA team.',
      changeRefs: ['owner-0'],
    },
    {
      id: 'staging',
      title: 'Separate staging from the verdict',
      explanationMarkdown: 'The staging label names a preview.',
      changeRefs: ['staging-1'],
      captions: [
        {
          changeRef: 'staging-1',
          side: 'after',
          startLine: 21,
          endLine: 21,
          text: 'Staging now only previews.',
        },
      ],
    },
  ],
};

it('draws a saved stop’s located caption on its own card, with the letter Files gives it', async () => {
  const reading = buildWalkthroughReading({
    comparison: COMPARISON,
    walkthrough: { state: 'complete', value: WALKTHROUGH },
    analysis: null,
    reviewed: null,
  });
  const screen = await renderScreen(
    <WalkthroughView
      reading={reading}
      scopeLabel="Pending changes"
      layout="wide"
    />,
  );
  const stop = screen.findByTestId('walkthrough-stop-staging');
  expect(stop).not.toBeNull();
  // The card holds only this stop's hunk; its caption sits on new line 21 there, lettered as in Files' Explain.
  await vi.waitFor(() =>
    expect(
      stop!.findAll(
        (node) => node.props.testID === 'walkthrough-caption-marker-A',
      ).length,
    ).toBeGreaterThan(0),
  );
  // The stop without captions draws its code alone.
  const plain = screen.findByTestId('walkthrough-stop-owner');
  expect(
    plain!.findAll(
      (node) =>
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('walkthrough-caption-marker'),
    ),
  ).toHaveLength(0);
});
