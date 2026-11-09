/**
 * @vitest-environment jsdom
 *
 * Real react-native-web and react-dom: a file header's GitHub Viewed mark. The source's keyed state
 * decides what it shows; only the write itself is a boundary here.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createScmFileViewedState,
  type ScmFileViewedSource,
} from '@/sync/domains/scm/fileViewed';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
  const { createRequire } =
    getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>(
      'node:module',
    );
  const actual: Record<string, unknown> = await vi.importActual(
    createRequire(import.meta.url).resolve('react-native-web'),
  );
  return (
    await import('@/dev/testkit/mocks/reactNative')
  ).createReactNativeWebMock(actual);
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));

const { Pressable } = await import('react-native');
const { ScmFileViewedMark, ScmFileViewedFact } =
  await import('./ScmFileViewedMark');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const PATHS = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] as const;

/** The real keyed store; the write answers when the test says so (the GitHub mutation boundary). */
function source() {
  const state = createScmFileViewedState();
  state.applyRead({
    kind: 'ready',
    headOid: 'head',
    files: [
      { path: PATHS[0], state: 'viewed' },
      { path: PATHS[1], state: 'unviewed' },
      { path: PATHS[2], state: 'dismissed' },
    ],
  });
  const answers: Array<(accepted: boolean) => void> = [];
  const writes: Array<Readonly<{ path: string; viewed: boolean }>> = [];
  const viewed: ScmFileViewedSource = {
    ...state,
    refresh: async () => {},
    setViewed: async (path, next) => {
      const previous = state.getFile(path);
      if (previous.state === null || previous.pending) return false;
      writes.push({ path, viewed: next });
      state.applyFile(path, { ...previous, pending: true, errorCode: null });
      const accepted = await new Promise<boolean>((resolve) =>
        answers.push(resolve),
      );
      state.applyFile(
        path,
        accepted
          ? {
              state: next ? 'viewed' : 'unviewed',
              pending: false,
              errorCode: null,
            }
          : { ...previous, pending: false, errorCode: 'permission' },
      );
      return accepted;
    },
  };
  return { viewed, answers, writes };
}

function render(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(element));
}

const box = (path: string) =>
  document.querySelector<HTMLElement>(
    `[data-testid="scm-file-viewed-${path.replace(/[^a-zA-Z0-9.]/g, '_')}"]`,
  );

describe('ScmFileViewedMark', () => {
  it('draws viewed, unviewed and dismissed as GitHub does, and never draws an unanswered file as unviewed', () => {
    const { viewed } = source();
    render(
      <>
        {PATHS.map((path) => (
          <ScmFileViewedMark
            key={path}
            source={viewed}
            path={path}
            setFileViewed={viewed.setViewed}
          />
        ))}
      </>,
    );
    expect(box(PATHS[0])?.getAttribute('aria-checked')).toBe('true');
    expect(box(PATHS[1])?.getAttribute('aria-checked')).toBe('false');
    expect(box(PATHS[2])?.getAttribute('aria-checked')).toBe('false');
    expect(
      document.querySelector(
        '[data-testid="scm-file-viewed-changed-src_c.ts"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="scm-file-viewed-changed-src_b.ts"]',
      ),
    ).toBeNull();
    // Unknown: the slot is held, but there is no checkbox to read as unchecked.
    expect(box(PATHS[3])).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="scm-file-viewed-unknown-src_d.ts"]',
      ),
    ).not.toBeNull();
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(3);
  });

  it('toggles only its file, holds while pending, keeps the previous mark when the write is refused, and never toggles the header', async () => {
    const { viewed, answers, writes } = source();
    const headerPresses = vi.fn();
    render(
      // The file header is itself a press target (it toggles the diff).
      <Pressable onPress={headerPresses}>
        <ScmFileViewedMark
          source={viewed}
          path={PATHS[1]}
          setFileViewed={viewed.setViewed}
        />
        <ScmFileViewedFact source={viewed} total={4} />
      </Pressable>,
    );
    const fact = () =>
      document.querySelector('[data-testid="scm-file-viewed-fact"]')
        ?.textContent;
    expect(fact()).toContain('1');

    act(() => box(PATHS[1])!.click());
    act(() => box(PATHS[1])!.click());
    expect(writes).toEqual([{ path: PATHS[1], viewed: true }]);
    expect(headerPresses).not.toHaveBeenCalled();
    await act(async () => {
      answers.shift()!(true);
    });
    expect(box(PATHS[1])?.getAttribute('aria-checked')).toBe('true');
    expect(fact()).toContain('2');

    act(() => box(PATHS[1])!.click());
    await act(async () => {
      answers.shift()!(false);
    });
    expect(box(PATHS[1])?.getAttribute('aria-checked')).toBe('true');
    expect(
      document.querySelector('[data-testid="scm-file-viewed-failed-src_b.ts"]'),
    ).not.toBeNull();
    expect(fact()).toContain('2');
  });

  it('says once in the header that the source is unavailable', () => {
    const state = createScmFileViewedState();
    state.fail('insufficient_scope');
    const viewed: ScmFileViewedSource = {
      ...state,
      refresh: async () => {},
      setViewed: async () => false,
    };
    render(
      <>
        <ScmFileViewedFact source={viewed} total={4} />
        <ScmFileViewedMark
          source={viewed}
          path={PATHS[0]}
          setFileViewed={viewed.setViewed}
        />
      </>,
    );
    expect(
      document.querySelector(
        '[data-testid="scm-file-viewed-fact-unavailable"]',
      ),
    ).not.toBeNull();
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
  });
});
