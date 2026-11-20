import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createThemeFixture, standardCleanup } from '@/dev/testkit';
import {
  createSessionFilesViewFixture,
  fileViewSnapshot,
  installSessionFilesViewBoundaries,
  prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { scmFileStatusFromChange } from '@/scm/scmStatusFiles';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import type { ScmDiffSummaryWalkthrough } from '@happier-dev/protocol/scm/diffSummary';

installSessionFilesViewBoundaries({ platformOS: 'web', renderItemLimit: 10 });
await prepareSessionFilesViewTestkit();

const CAPTIONED = 'src/reconnectPolicy.ts';
const PLAIN = 'src/plain.ts';
const HUNK = [
  '@@ -12,7 +12,8 @@',
  ' const BASE_MS = 1_000;',
  '-const MAX_ATTEMPTS = 20;',
  '+const MAX_MS = 30_000;',
  '+const GIVE_UP_MS = 300_000;',
  ' ',
  ' export function scheduleReconnect(attempt: number) {',
  '-    const delay = BASE_MS;',
  '+    const delay = Math.min(BASE_MS * 2 ** attempt, MAX_MS);',
  '     return delay;',
  ' }',
].join('\n');
const PLAIN_HUNK = '@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;';
const diffOf = (path: string, hunk: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk}\n`;

const COMPARISON: ScmComparison = {
  id: 'captions-comparison',
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
        evidence: { state: 'available', unifiedDiff: diffOf(CAPTIONED, HUNK) },
        occurrences: [
          {
            id: 'policy-0',
            alias: 'c1',
            path: CAPTIONED,
            position: 0,
            before: { startLine: 12, lineCount: 7 },
            after: { startLine: 12, lineCount: 8 },
          },
        ],
      },
      {
        path: PLAIN,
        changeKind: 'modified',
        binary: false,
        generated: false,
        lockfile: false,
        evidence: {
          state: 'available',
          unifiedDiff: diffOf(PLAIN, PLAIN_HUNK),
        },
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
  stops: [
    {
      id: 'backoff',
      title: 'Back off between attempts',
      explanationMarkdown: 'Reconnect waits longer after each failure. More.',
      changeRefs: ['policy-0'],
      captions: [
        // Authored out of file order: letters follow the file, not the narrator.
        {
          changeRef: 'policy-0',
          side: 'after',
          startLine: 17,
          endLine: 17,
          text: 'Doubles the wait <b>and caps</b> it at 30 s.',
        },
        {
          changeRef: 'policy-0',
          side: 'after',
          startLine: 13,
          endLine: 14,
          text: 'The two limits.',
        },
        {
          changeRef: 'policy-0',
          side: 'after',
          startLine: 40,
          endLine: 41,
          text: 'Lines the drawn hunk does not hold.',
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
  otherChangeRefs: [],
};

describe('Files Explain line captions', () => {
  let fixture:
    | Awaited<ReturnType<typeof createSessionFilesViewFixture>>
    | undefined;
  afterEach(async () => {
    standardCleanup();
    await fixture?.dispose();
    fixture = undefined;
  });

  it('letters captions in file order, pairs a caption with its lines, and an agent shows one through the page command', async () => {
    fixture = await createSessionFilesViewFixture();
    const { WorkspaceScmReviewBody } =
      await import('@/components/projects/scm/WorkspaceScmReviewBody');
    const { ChangedFilesReview } =
      await import('@/components/workspaces/scm/review/ChangedFilesReview');
    const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
    const { buildWalkthroughReading } = await import('./walkthroughReading');
    const { renderMountedCurrentUiContext } =
      await import('@/dev/testkit/harness/mountedCurrentUiContext');
    const { readCurrentUiContextActionReader } =
      await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
    const { createDefaultActionExecutor } =
      await import('@/sync/ops/actions/defaultActionExecutor');
    const { ACTION_ID_FAMILIES_V1 } =
      await import('@happier-dev/protocol/actions/actionIds');

    const reading = buildWalkthroughReading({
      comparison: COMPARISON,
      walkthrough: { state: 'complete', value: WALKTHROUGH },
      analysis: null,
      reviewed: null,
    });
    const files = [CAPTIONED, PLAIN].map((path) =>
      scmFileStatusFromChange({
        path,
        changeKind: 'modified',
        added: 2,
        removed: 1,
      }),
    );
    const diffs = new Map(
      COMPARISON.inventory.files.map(
        (file) => [file.path, file.evidence.unifiedDiff ?? null] as const,
      ),
    );
    const focused: string[] = [];
    const body = (explain: boolean) => (
      <WorkspaceScmReviewBody
        comparison={{ kind: 'workingTree' }}
        view="files"
        scopeLabel="Changes"
        scopeOptions={[]}
        onSelectComparison={() => {}}
        onSelectView={() => {}}
        reading={reading}
        explain={explain}
        onExplainChange={() => {}}
        renderWalkthrough={() => null}
        renderFiles={(chrome) => (
          <ChangedFilesReview
            comparisonChrome={{ ...chrome, indexPlacement: 'rail' }}
            sessionId={fixture!.session.id}
            workspaceScope={fixture!.scope}
            theme={createThemeFixture()}
            snapshot={fileViewSnapshot()}
            changedFilesViewMode="repository"
            allRepositoryChangedFiles={files}
            sessionAttributedFiles={[]}
            repositoryOnlyFiles={[]}
            maxFiles={10}
            maxChangedLines={1000}
            onFilePress={() => {}}
            providerDiffByPath={diffs}
          />
        )}
      />
    );
    const screen = await renderMountedCurrentUiContext(body(true), {
      // The host layout boundary: measured nodes, and the focus a revealed marker takes.
      createNodeMock: (element) => ({
        focus: () => {
          focused.push(String(element.props.testID ?? ''));
        },
        scrollIntoView: () => {},
        measureLayout: (_relative: unknown, onSuccess: (x: number, y: number, width: number, height: number) => void) => onSuccess(0, 0, 0, 22),
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 22, 22),
        measure: (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(0, 0, 22, 22, 0, 0),
        getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 22, height: 22, right: 22, bottom: 22 }),
      }),
    });
    try {
      const viewerFor = (path: string) =>
        screen
          .findAllByType(DiffViewer)
          .find((viewer) => viewer.props.filePath === path);
      await vi.waitFor(() => {
        expect(viewerFor(CAPTIONED)).toBeDefined();
        expect(viewerFor(PLAIN)).toBeDefined();
      });
      // A file without captions draws its diff alone: no lane cell, no tint.
      expect(viewerFor(PLAIN)!.props.renderLeadingLane).toBeUndefined();
      expect(viewerFor(PLAIN)!.props.highlightLineIds).toBeUndefined();
      expect(viewerFor(CAPTIONED)!.props.renderLeadingLane).toEqual(
        expect.any(Function),
      );

      // A (13–14) and B (17) are drawn; C's lines are not in the hunk: its note reads, with no marker and no jump.
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('walkthrough-caption-marker-A'),
        ).not.toBeNull(),
      );
      expect(
        screen.findByTestId('walkthrough-caption-marker-B'),
      ).not.toBeNull();
      expect(screen.findByTestId('walkthrough-caption-marker-C')).toBeNull();
      const noteC = screen.findHostByTestId('walkthrough-caption-C');
      expect(noteC).not.toBeNull();
      expect(
        noteC!.props.role ?? noteC!.props.accessibilityRole,
      ).toBeUndefined();
      expect(screen.getTextContent()).toContain(
        'Lines the drawn hunk does not hold.',
      );

      // Pressing caption B in the notes tints its one line, lights its letter and floats its words, as text.
      await screen.pressByTestIdAsync('walkthrough-caption-B');
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('walkthrough-caption-callout'),
        ).not.toBeNull(),
      );
      expect(viewerFor(CAPTIONED)!.props.highlightLineIds?.size).toBe(1);
      expect(
        screen
          .findByTestId('walkthrough-caption-callout')!
          .findAll((node) =>
            node.children.includes(
              'Doubles the wait <b>and caps</b> it at 30 s.',
            ),
          ).length,
      ).toBeGreaterThan(0);
      expect(focused).toContain('walkthrough-caption-marker-B');

      // An agent shows caption A through the page's one command; the same pairing follows.
      const command = await vi.waitFor(() => {
        const selected = readCurrentUiContextActionReader({ surface: 'agent' })!
          .readCurrentUiContext()!
          .commands.find((row) =>
            row.description?.includes('walkthrough.caption.show'),
          );
        expect(selected).toBeDefined();
        return selected!;
      });
      await act(async () => {
        const outcome = await createDefaultActionExecutor().execute(
          ACTION_ID_FAMILIES_V1.current_ui_context[1],
          { commandId: command.id, input: { path: CAPTIONED, letter: 'A' } },
          {
            surface: 'agent',
            authority: 'account_automation',
            expectedAccountId: 'alice',
            actionRequestId: 'caption-show-a',
          },
        );
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
      });
      await vi.waitFor(() =>
        expect(viewerFor(CAPTIONED)!.props.highlightLineIds?.size).toBe(2),
      );

      // Explain off: every diff draws exactly as without captions, and the command leaves the page.
      await screen.update(body(false));
      await vi.waitFor(() =>
        expect(viewerFor(CAPTIONED)!.props.renderLeadingLane).toBeUndefined(),
      );
      expect(screen.findByTestId('walkthrough-caption-marker-A')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
