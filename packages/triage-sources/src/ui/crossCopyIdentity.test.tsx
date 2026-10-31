// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  TriageEvidenceCandidateV1,
  TriageEvidenceDisclosureOutcomeV1,
  TriageEvidenceDisclosureResolverV1,
  TriageEvidenceDisclosureV1,
} from './evidenceDisclosure.js';
import type { TriagePostMutationCompletionV1 } from './postMutation.js';

/**
 * The Triage parent and the source detail it mounts are SEPARATE bundles.
 *
 * `PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS` host-provides only React, its JSX
 * runtimes, RNW and the SDK UI client, so `@happier-dev/triage-sources` is
 * bundled into every plugin artifact that imports it. The Triage aggregate
 * installs both providers from ITS copy; Sentry, PostHog and the four forges
 * read them from THEIRS. A source-import test shares one module graph and
 * therefore cannot see whether these two seams survive that split at all.
 *
 * So this file builds the real modules the way the product builds them — one
 * bundle per artifact, React external — and evaluates the output twice against
 * the SAME React runtime the renderer uses. Copy A stands for the Triage
 * aggregate; copy B stands for an independently loaded source detail.
 */

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDirectory, '../../../..');

/**
 * esbuild refuses to load inside this file's jsdom environment (its
 * `TextEncoder` returns a foreign-realm `Uint8Array`), and the renderer below
 * needs that environment. So the bundle is produced in a plain Node child,
 * which is also the closer analogue of the real per-artifact build.
 */
const BUNDLE_ARTIFACT_SCRIPT = [
  "const { buildSync } = require('esbuild');",
  'const result = buildSync({',
  '  entryPoints: [process.argv[1]],',
  '  bundle: true,',
  '  write: false,',
  "  format: 'cjs',",
  "  platform: 'neutral',",
  // The product tsconfig uses the classic runtime, so the only module the
  // emitted artifact may ask the host for is React itself.
  "  jsx: 'transform',",
  "  external: ['react'],",
  "  logLevel: 'silent',",
  '});',
  'process.stdout.write(result.outputFiles[0].text);',
].join('\n');

type DisclosureModule = Readonly<{
  TriageEvidenceDisclosureProvider: (props: Readonly<{
    disclosure: TriageEvidenceDisclosureV1;
    children: React.ReactNode;
  }>) => React.ReactElement;
  useTriageEvidenceDisclosure: () => TriageEvidenceDisclosureV1;
}>;

type PostMutationModule = Readonly<{
  TriagePostMutationCompletionProvider: (props: Readonly<{
    onComplete: TriagePostMutationCompletionV1;
    children: React.ReactNode;
  }>) => React.ReactElement;
  useTriagePostMutationCompletion: () => TriagePostMutationCompletionV1;
}>;

function bundleArtifactCode(entryFileName: string): string {
  const code = execFileSync(
    process.execPath,
    ['-e', BUNDLE_ARTIFACT_SCRIPT, resolve(moduleDirectory, entryFileName)],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (code.trim() === '') throw new Error(`esbuild produced no output for ${entryFileName}`);
  return code;
}

/**
 * One independently loaded artifact copy. `require` hands back the exact React
 * this test renders with, which is what the host external guarantees in the
 * product: separate bundles, one shared React.
 */
function loadArtifactCopy<T>(code: string): T {
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', code) as (
    require: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
  ) => void;
  evaluate(
    (specifier) => {
      if (specifier === 'react') return React;
      throw new Error(`Unexpected non-external import ${specifier} in a plugin artifact`);
    },
    moduleObject,
    moduleObject.exports,
  );
  return moduleObject.exports as T;
}

let disclosureCode = '';
let postMutationCode = '';

beforeAll(() => {
  disclosureCode = bundleArtifactCode('evidenceDisclosure.tsx');
  postMutationCode = bundleArtifactCode('postMutation.tsx');
}, 120_000);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

function mount(node: React.ReactElement): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => { root?.render(node); });
}

function render(node: React.ReactElement): void {
  act(() => { root?.render(node); });
}

const CANDIDATE: TriageEvidenceCandidateV1 = Object.freeze({
  reference: { pluginId: 'happier.example.source', localId: 'evidence' },
  candidate: { id: 'event-17', label: 'TypeError: undefined is not a function' },
});

describe('Triage evidence disclosure across independently bundled artifacts', () => {
  it('reaches a source detail whose own copy of the seam was bundled separately', async () => {
    const aggregate = loadArtifactCopy<DisclosureModule>(disclosureCode);
    const sourceDetail = loadArtifactCopy<DisclosureModule>(disclosureCode);
    // Two artifacts, not one: a shared module instance would make every
    // assertion below vacuous.
    expect(sourceDetail).not.toBe(aggregate);
    expect(sourceDetail.useTriageEvidenceDisclosure).not.toBe(aggregate.useTriageEvidenceDisclosure);

    const disclose = vi.fn(async (
      resolveCandidate: TriageEvidenceDisclosureResolverV1,
    ): Promise<TriageEvidenceDisclosureOutcomeV1> => {
      const disclosed = await resolveCandidate(new AbortController().signal);
      return disclosed === null ? { kind: 'cancelled' } : { kind: 'applied' };
    });
    let available: boolean | null = null;
    let outcome: TriageEvidenceDisclosureOutcomeV1 | null = null;
    const primaryWrite = { title: 'Complete change', pending: false, disabledReason: null,
      execute: vi.fn(async () => {}) };
    const offer = vi.fn();

    function SourceDetail(): React.ReactElement {
      const disclosure = sourceDetail.useTriageEvidenceDisclosure();
      available = disclosure.available;
      React.useLayoutEffect(() => {
        disclosure.primaryWrite?.offer(primaryWrite);
        return () => { disclosure.primaryWrite?.offer(null); };
      }, [disclosure.primaryWrite]);
      return (
        <button
          disabled={!disclosure.available}
          onClick={() => {
            void disclosure.disclose(async () => CANDIDATE).then((result) => { outcome = result; });
          }}
        >
          disclose
        </button>
      );
    }

    mount(
      <aggregate.TriageEvidenceDisclosureProvider disclosure={{ available: true, disclose, primaryWrite: { offer } }}>
        <SourceDetail />
      </aggregate.TriageEvidenceDisclosureProvider>,
    );
    await act(async () => { container?.querySelector('button')?.click(); });

    expect(available).toBe(true);
    expect(disclose).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'applied' });
    expect(offer).toHaveBeenCalledWith(primaryWrite);
    await offer.mock.calls[0]?.[0]?.execute();
    expect(primaryWrite.execute).toHaveBeenCalledOnce();
  });

  it('does not depend on which artifact copy was loaded first', async () => {
    const first = loadArtifactCopy<DisclosureModule>(disclosureCode);
    const second = loadArtifactCopy<DisclosureModule>(disclosureCode);
    const disclose = vi.fn(async (): Promise<TriageEvidenceDisclosureOutcomeV1> => ({ kind: 'settled' }));
    let available: boolean | null = null;

    function SourceDetail(): React.ReactElement {
      available = first.useTriageEvidenceDisclosure().available;
      return <span>detail</span>;
    }

    // The later-loaded copy provides; the earlier-loaded copy consumes.
    mount(
      <second.TriageEvidenceDisclosureProvider disclosure={{ available: true, disclose }}>
        <SourceDetail />
      </second.TriageEvidenceDisclosureProvider>,
    );

    expect(available).toBe(true);
  });

  it('follows a replacement disclosure and reports inert once the aggregate is gone', async () => {
    const aggregate = loadArtifactCopy<DisclosureModule>(disclosureCode);
    const sourceDetail = loadArtifactCopy<DisclosureModule>(disclosureCode);
    const firstEntry = vi.fn(async (): Promise<TriageEvidenceDisclosureOutcomeV1> => ({ kind: 'applied' }));
    const secondEntry = vi.fn(async (): Promise<TriageEvidenceDisclosureOutcomeV1> => ({ kind: 'applied' }));
    let available: boolean | null = null;
    let outcome: TriageEvidenceDisclosureOutcomeV1 | null = null;
    const resolveCandidate = vi.fn(async () => CANDIDATE);

    function SourceDetail(): React.ReactElement {
      const disclosure = sourceDetail.useTriageEvidenceDisclosure();
      available = disclosure.available;
      return (
        <button onClick={() => { void disclosure.disclose(resolveCandidate).then((r) => { outcome = r; }); }}>
          disclose
        </button>
      );
    }

    mount(
      <aggregate.TriageEvidenceDisclosureProvider disclosure={{ available: true, disclose: firstEntry }}>
        <SourceDetail />
      </aggregate.TriageEvidenceDisclosureProvider>,
    );
    render(
      <aggregate.TriageEvidenceDisclosureProvider disclosure={{ available: true, disclose: secondEntry }}>
        <SourceDetail />
      </aggregate.TriageEvidenceDisclosureProvider>,
    );
    await act(async () => { container?.querySelector('button')?.click(); });

    expect(firstEntry).not.toHaveBeenCalled();
    expect(secondEntry).toHaveBeenCalledTimes(1);

    // The same source detail, now mounted outside the aggregate. Nothing about
    // the previous mount may survive: a retained value here would mean the seam
    // had become a process-wide store rather than a mounted parent's context.
    render(<SourceDetail />);
    await act(async () => { container?.querySelector('button')?.click(); });

    expect(available).toBe(false);
    expect(resolveCandidate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'inert' });
  });

  it('stays inert for a separately bundled detail that has no Triage parent at all', async () => {
    const sourceDetail = loadArtifactCopy<DisclosureModule>(disclosureCode);
    const resolveCandidate = vi.fn(async () => CANDIDATE);
    let available: boolean | null = null;
    let outcome: TriageEvidenceDisclosureOutcomeV1 | null = null;

    function SourceDetail(): React.ReactElement {
      const disclosure = sourceDetail.useTriageEvidenceDisclosure();
      available = disclosure.available;
      return (
        <button onClick={() => { void disclosure.disclose(resolveCandidate).then((r) => { outcome = r; }); }}>
          disclose
        </button>
      );
    }

    mount(<SourceDetail />);
    await act(async () => { container?.querySelector('button')?.click(); });

    expect(available).toBe(false);
    expect(resolveCandidate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'inert' });
  });
});

describe('Triage post-mutation completion across independently bundled artifacts', () => {
  it('reaches the aggregate re-read from a source detail bundled separately', async () => {
    const aggregate = loadArtifactCopy<PostMutationModule>(postMutationCode);
    const sourceDetail = loadArtifactCopy<PostMutationModule>(postMutationCode);
    expect(sourceDetail).not.toBe(aggregate);

    const onComplete = vi.fn(async () => undefined);

    function SourceDetail(): React.ReactElement {
      const complete = sourceDetail.useTriagePostMutationCompletion();
      return <button onClick={() => { void complete(); }}>settled</button>;
    }

    mount(
      <aggregate.TriagePostMutationCompletionProvider onComplete={onComplete}>
        <SourceDetail />
      </aggregate.TriagePostMutationCompletionProvider>,
    );
    await act(async () => { container?.querySelector('button')?.click(); });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('follows a replacement target and goes quiet once the aggregate unmounts', async () => {
    const aggregate = loadArtifactCopy<PostMutationModule>(postMutationCode);
    const sourceDetail = loadArtifactCopy<PostMutationModule>(postMutationCode);
    const firstEntry = vi.fn(async () => undefined);
    const secondEntry = vi.fn(async () => undefined);

    function SourceDetail(): React.ReactElement {
      const complete = sourceDetail.useTriagePostMutationCompletion();
      return <button onClick={() => { void complete(); }}>settled</button>;
    }

    mount(
      <aggregate.TriagePostMutationCompletionProvider onComplete={firstEntry}>
        <SourceDetail />
      </aggregate.TriagePostMutationCompletionProvider>,
    );
    render(
      <aggregate.TriagePostMutationCompletionProvider onComplete={secondEntry}>
        <SourceDetail />
      </aggregate.TriagePostMutationCompletionProvider>,
    );
    await act(async () => { container?.querySelector('button')?.click(); });

    expect(firstEntry).not.toHaveBeenCalled();
    expect(secondEntry).toHaveBeenCalledTimes(1);

    render(<SourceDetail />);
    await act(async () => { container?.querySelector('button')?.click(); });

    expect(secondEntry).toHaveBeenCalledTimes(1);
  });

  it('is safe for a separately bundled detail mounted outside the aggregate', async () => {
    const sourceDetail = loadArtifactCopy<PostMutationModule>(postMutationCode);
    let completion: Promise<void> | undefined;

    function SourceDetail(): React.ReactElement {
      const complete = sourceDetail.useTriagePostMutationCompletion();
      return <button onClick={() => { completion = complete(); }}>settled</button>;
    }

    mount(<SourceDetail />);
    await act(async () => {
      container?.querySelector('button')?.click();
      await expect(completion).resolves.toBeUndefined();
    });
  });
});
