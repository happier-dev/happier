// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';

import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import type { ScmDiffSummaryWalkthrough } from '@happier-dev/protocol/scm/diffSummary';

import { buildWalkthroughReading } from './walkthroughReading';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
// A phone: the shared popover presents as the bottom sheet (its portal and measurement are the boundary).
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
  return createInlinePopoverModuleMock(importOriginal, { maxHeight: 400, maxWidth: 390, placement: 'bottom', presentation: 'sheet' });
});
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
// The recycler has no measured viewport in the test renderer: its boundary mock draws the first rows, the code view's
// rows and lane stay real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
  return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(), renderItemLimit: 40, emitViewability: false }).module;
});

const { pressTestInstanceAsync, renderScreen } = await import('@/dev/testkit/render/renderScreen');
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
          startLine: 20,
          endLine: 21,
          text: 'Staging now only previews.',
        },
        {
          changeRef: 'staging-1',
          side: 'after',
          startLine: 22,
          endLine: 22,
          text: 'The ending stays the same.',
        },
      ],
    },
  ],
};

it('on a phone, lands caption lines above the sheet and steps without a mounted marker ref', async () => {
  const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
  const reading = buildWalkthroughReading({ comparison: COMPARISON, walkthrough: { state: 'complete', value: WALKTHROUGH },
    analysis: null, reviewed: null });
  // The first line of A is above the rendered window. Its end line and B still have native nodes.
  const screen = await renderScreen(<WalkthroughView reading={reading} scopeLabel="Pending changes" layout="phone" />, {
    createNodeMock: (element) => element.props.testID === 'walkthrough-caption-marker-A' ? null : ({
      focus: () => {}, scrollIntoView: () => {},
      measure: (callback: (...values: number[]) => void) => callback(0, 0, 22, 22, 0, 0),
      measureInWindow: (callback: (...values: number[]) => void) => callback(0, 0, 22, 22),
      measureLayout: (_relative: unknown, onSuccess: (...values: number[]) => void) => onSuccess(0, 0, 22, 22) }),
  });
  await vi.waitFor(() => expect(screen.findByTestId('walkthrough-caption-marker-B')).not.toBeNull());
  const viewer = () => screen.findAllByType(DiffViewer).find((candidate) => candidate.props.filePath === PATH
    && String(candidate.props.unifiedDiff).includes('staging: preview only'))!;
  expect(viewer().props.scrollToLineId).toBeUndefined();
  await screen.pressByTestIdAsync('walkthrough-caption-marker-B');
  await vi.waitFor(() => expect(screen.findHostByTestId('walkthrough-caption-sheet')).not.toBeNull());
  await act(async () => {
    screen.findHostByTestId('walkthrough-caption-sheet')!.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 312 } } });
  });
  // The sheet covers the bottom of the screen: the code view lands the caption's first line at its reading line, above it.
  const scrollLine = () => {
    const target = viewer().props.scrollToLineId as string | undefined;
    return buildCodeLinesFromUnifiedDiff({ unifiedDiff: viewer().props.unifiedDiff as string, hideFilePrelude: true })
      .find((entry) => entry.id === target);
  };
  await vi.waitFor(() => expect(scrollLine()?.newLine).toBe(22));

  const previousCaption = screen.findHostByTestId('walkthrough-caption-sheet')!.findAll(
    node => typeof node.type === 'string' && node.props.accessibilityLabel === 'walkthrough.explain.previousCaption',
  )[0];
  await pressTestInstanceAsync(previousCaption, 'Previous caption');
  expect(screen.getTextContent()).toContain('Staging now only previews.');
  await vi.waitFor(() => expect(scrollLine()?.newLine).toBe(20));
});

it('on a phone, a caption among the last lines still clears the sheet: the scroller gets the sheet\u2019s room until it closes', async () => {
  const { Popover } = await import('@/components/ui/popover');
  const reading = buildWalkthroughReading({ comparison: COMPARISON, walkthrough: { state: 'complete', value: WALKTHROUGH },
    analysis: null, reviewed: null });
  // The page's scroller is at its end when the caption's line is one of the last: the host layout boundary gives
  // every mounted node a real element inside a scrolled page, so the room the sheet needs is observable on it.
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  Object.defineProperty(scroller, 'clientHeight', { value: 844 });
  Object.defineProperty(scroller, 'scrollHeight', { value: 2000 });
  document.body.appendChild(scroller);
  const screen = await renderScreen(<WalkthroughView reading={reading} scopeLabel="Pending changes" layout="phone" />, {
    createNodeMock: () => {
      const node = document.createElement('div');
      scroller.appendChild(node);
      return Object.assign(node, {
        measure: (callback: (...values: number[]) => void) => callback(0, 0, 22, 22, 0, 0),
        measureInWindow: (callback: (...values: number[]) => void) => callback(0, 0, 22, 22),
        measureLayout: (_relative: unknown, onSuccess: (...values: number[]) => void) => onSuccess(0, 0, 22, 22),
      });
    },
  });
  await vi.waitFor(() => expect(screen.findByTestId('walkthrough-caption-marker-A')).not.toBeNull());
  expect(scroller.style.paddingBottom).toBe('');
  await screen.pressByTestIdAsync('walkthrough-caption-marker-A');
  await vi.waitFor(() => expect(screen.findHostByTestId('walkthrough-caption-sheet')).not.toBeNull());
  // The sheet lays out at its measured height.
  await act(async () => {
    screen.findHostByTestId('walkthrough-caption-sheet')!.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 312 } } });
  });
  await vi.waitFor(() => expect(scroller.style.paddingBottom).toBe('312px'));
  // Closing the sheet gives the room back.
  await act(async () => {
    screen.findAllByType(Popover).find((popover) => popover.props.phonePresentation === 'sheet')!.props.onRequestClose();
  });
  await vi.waitFor(() => expect(screen.findByTestId('walkthrough-caption-sheet')).toBeNull());
  expect(scroller.style.paddingBottom).toBe('');
  scroller.remove();
});
