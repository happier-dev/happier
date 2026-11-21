// @vitest-environment jsdom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storageStore';
import { BrowserWorker } from '@/components/ui/code/diff/pierre/pierreWorkerTestHelpers';
import { getPierreDiffWorkerPool } from '@/components/ui/code/diff/pierre/pierreWorkerPool.web';
import { usePierreDiffRendererPreload } from '@/components/ui/code/diff/pierre/pierreRendererLoader.web';
import { ChangedFilesReviewDiffBlock } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffBlock';
import { createChangedFilesReviewDiffStateSource } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { WalkthroughExplainNotes } from './WalkthroughExplainNotes';
import { WalkthroughCaptionLane, createWalkthroughCaptionFocus } from './WalkthroughCaptions';
import { buildWalkthroughReading } from './walkthroughReading';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import type { ScmDiffSummaryWalkthrough } from '@happier-dev/protocol/scm/diffSummary';

// The browser's React Native is react-native-web: the real DOM renderer under the shared components.
vi.mock('react-native', async () => {
  const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
  const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
  return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
// The browser build resolves the diff viewer to its web variant (Metro's platform extension); tests do the same here.
vi.mock(
  '@/components/ui/code/diff/DiffViewer',
  async () => await import('@/components/ui/code/diff/DiffViewer.web'),
);

const CAPTIONED = 'src/reconnectPolicy.ts';
const PLAIN = 'src/plain.ts';
const LARGE = 'src/large.ts';
const header = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
const CAPTIONED_DIFF = `${header(CAPTIONED)}@@ -12,3 +12,4 @@\n const BASE_MS = 1_000;\n-const MAX_ATTEMPTS = 20;\n+const MAX_MS = 30_000;\n+const GIVE_UP_MS = 300_000;\n export const backoff = true;\n`;
const PLAIN_DIFF = `${header(PLAIN)}@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n`;
const LARGE_LINES = 400;
const LARGE_DIFF = `${header(LARGE)}@@ -1,${LARGE_LINES} +1,${LARGE_LINES} @@\n${Array.from(
  { length: LARGE_LINES },
  (_, index) =>
    index === 0
      ? `-export const first = 0;\n+export const first = 1;`
      : ` export const line${index} = ${index};`,
).join('\n')}\n`;

const COMPARISON: ScmComparison = {
  id: 'captions-pierre',
  source: { kind: 'session', sessionId: 'captions-session' },
  repository: { rootPath: '/repo' },
  endpoints: { before: 'b0', after: 'a0' },
  inventory: {
    state: 'complete',
    reasons: [],
    files: [
      {
        path: CAPTIONED,
        changeKind: 'modified',
        binary: false,
        generated: false,
        lockfile: false,
        evidence: { state: 'available', unifiedDiff: CAPTIONED_DIFF },
        occurrences: [
          {
            id: 'policy-0',
            alias: 'c1',
            path: CAPTIONED,
            position: 0,
            before: { startLine: 12, lineCount: 3 },
            after: { startLine: 12, lineCount: 4 },
          },
        ],
      },
      {
        path: PLAIN,
        changeKind: 'modified',
        binary: false,
        generated: false,
        lockfile: false,
        evidence: { state: 'available', unifiedDiff: PLAIN_DIFF },
        occurrences: [
          {
            id: 'plain-0',
            alias: 'c2',
            path: PLAIN,
            position: 0,
            before: { startLine: 1, lineCount: 1 },
            after: { startLine: 1, lineCount: 1 },
          },
        ],
      },
    ],
  },
};
const WALKTHROUGH: ScmDiffSummaryWalkthrough = {
  title: 'Retry reconnect with backoff',
  intro: 'Reconnect waits longer after each failure.',
  otherChangeRefs: [],
  stops: [
    {
      id: 'backoff',
      title: 'Back off between attempts',
      explanationMarkdown: 'Reconnect waits longer.',
      changeRefs: ['policy-0'],
      captions: [
        {
          changeRef: 'policy-0',
          side: 'after',
          startLine: 13,
          endLine: 14,
          text: 'The two limits.',
        },
      ],
    },
    {
      id: 'plain',
      title: 'A plain change',
      explanationMarkdown: 'Nothing to caption.',
      changeRefs: ['plain-0'],
    },
  ],
};

/** The Files list starts the renderer's chunk and worker before its rows draw (as the review list does). */
function ExplainFiles(props: Readonly<{ children: React.ReactNode }>) {
  usePierreDiffRendererPreload(true);
  return <>{props.children}</>;
}

it('draws a captioned file and its plain neighbour through the same renderer, the caption letters in its leading lane', async () => {
  // The browser Worker is the boundary; the renderer chunk, pool, renderer choice and both diff renderers stay real.
  BrowserWorker.reset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Worker', BrowserWorker);
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  );
  const replaceSync = Object.getOwnPropertyDescriptor(
    CSSStyleSheet.prototype,
    'replaceSync',
  );
  Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', {
    configurable: true,
    value() {},
  });
  // Per-line layout reads of Pierre's gutters: the lane's cost on a file that has no lane must stay zero.
  const gutterReads = new Map<string, number>();
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: HTMLElement,
  ) {
    if (this.hasAttribute('data-column-number')) {
      const path =
        (this.getRootNode() as ShadowRoot).host
          ?.closest('[data-testid^="scm-review-diff-"]')
          ?.getAttribute('data-testid') ?? '';
      gutterReads.set(path, (gutterReads.get(path) ?? 0) + 1);
    }
    return rect.call(this);
  };
  const settings = storage.getState().settings;
  storage.setState({
    settings: {
      ...settings,
      filesDiffPresentationStyle: 'unified',
      filesDiffRendererMode: 'pierre',
      // The large file draws whole (no inline window), so every one of its gutters is mounted for the cost check.
      filesDiffInlineVirtualizationLineThreshold: 100_000,
      filesDiffInlineVirtualizationByteThreshold: 100_000_000,
    },
  });
  const reading = buildWalkthroughReading({
    comparison: COMPARISON,
    walkthrough: { state: 'complete', value: WALKTHROUGH },
    analysis: null,
    reviewed: null,
  });
  const focus = createWalkthroughCaptionFocus();
  const source = createChangedFilesReviewDiffStateSource([
    [CAPTIONED, { status: 'loaded', diff: CAPTIONED_DIFF, error: null }],
    [PLAIN, { status: 'loaded', diff: PLAIN_DIFF, error: null }],
    [LARGE, { status: 'loaded', diff: LARGE_DIFF, error: null }],
  ]);
  // Files' Explain as WorkspaceScmReviewBody composes it: notes beside each hunk, captions through the lane.
  const hunkNotes = {
    placement: 'inline' as const,
    columnWidth: 0,
    render: (
      path: string,
      hunkIndex: number,
      placement: 'column' | 'inline',
    ) => (
      <WalkthroughExplainNotes
        reading={reading}
        path={path}
        hunkIndex={hunkIndex}
        placement={placement}
        captionFocus={focus}
      />
    ),
    lineCaptions: (
      path: string,
      unifiedDiff: string,
      renderDiff: (
        lane: Parameters<
          React.ComponentProps<typeof WalkthroughCaptionLane>['children']
        >[0],
      ) => React.ReactNode,
    ) => {
      const captions = reading.captionsByPath.get(path);
      return captions ? (
        <WalkthroughCaptionLane
          path={path}
          captions={captions}
          focus={focus}
          unifiedDiff={unifiedDiff}
        >
          {renderDiff}
        </WalkthroughCaptionLane>
      ) : null;
    },
  };
  const block = (path: string) => (
    <ChangedFilesReviewDiffBlock
      key={path}
      theme={createThemeFixture()}
      sessionId="captions-session"
      snapshotSignature="sig"
      filePath={path}
      diffStateSource={source}
      reviewCommentsEnabled={false}
      reviewCommentDrafts={[]}
      flat
      hunkNotes={hunkNotes}
    />
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await React.act(async () =>
      root.render(<ExplainFiles>{null}</ExplainFiles>),
    );
    await vi.waitFor(() =>
      expect(
        getPierreDiffWorkerPool({ style: 'unified' })?.isInitialized(),
      ).toBe(true),
    { timeout: 15_000 });
    await React.act(async () =>
      root.render(
        <ExplainFiles>
          {block(CAPTIONED)}
          {block(PLAIN)}
          {block(LARGE)}
        </ExplainFiles>,
      ),
    );
    const drawnBy = (path: string) =>
      host.querySelector(
        `[data-testid="scm-review-diff-${path.replace(/[^a-zA-Z0-9._-]/g, '_')}"]`,
      );
    // One renderer for the page: every file, captioned or not, draws its code inside Pierre's host.
    await vi.waitFor(() => {
      const hosts = [CAPTIONED, PLAIN, LARGE].map((path) => drawnBy(path)?.querySelector('diffs-container')?.shadowRoot?.textContent?.includes('export const') === true);
      expect(hosts, `Pierre draws [captioned, plain, large]; light DOM: ${[CAPTIONED, PLAIN, LARGE].map((path) => drawnBy(path) ? (drawnBy(path)!.textContent ?? '').slice(0, 60) : 'missing').join(' | ')}`).toEqual([true, true, true]);
    }, { timeout: 15_000 });
    // The captioned file keeps its neighbours' renderer, and its letter sits in the lane beside line 13.
    await vi.waitFor(() =>
      expect(
        drawnBy(CAPTIONED)?.querySelector(
          '[data-happier-leading-lane] [data-testid="walkthrough-caption-marker-A"]',
        ),
      ).not.toBeNull(),
    { timeout: 15_000 });
    expect(
      drawnBy(PLAIN)?.querySelector('[data-happier-leading-lane]'),
    ).toBeNull();
    expect(
      drawnBy(LARGE)?.querySelector('[data-happier-leading-lane]'),
    ).toBeNull();
    expect(
      [...gutterReads.entries()].filter(
        ([path]) => !path.includes('reconnectPolicy'),
      ),
      'a file without a lane reads no gutter row',
    ).toEqual([]);
  } finally {
    await React.act(async () => root.unmount());
    HTMLElement.prototype.getBoundingClientRect = rect;
    getPierreDiffWorkerPool({ style: 'unified' })?.terminate();
    host.remove();
    storage.setState({ settings });
    if (replaceSync)
      Object.defineProperty(
        CSSStyleSheet.prototype,
        'replaceSync',
        replaceSync,
      );
    else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
    BrowserWorker.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
