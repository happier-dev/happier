// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TriageEvidenceDisclosureProvider,
  useTriageEvidenceDisclosure,
  type TriageEvidenceCandidateV1,
  type TriageEvidenceDisclosureOutcomeV1,
} from './evidenceDisclosure.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

const CANDIDATE: TriageEvidenceCandidateV1 = Object.freeze({
  reference: { pluginId: 'happier.example.source', localId: 'evidence' },
  candidate: { id: 'event-17', label: 'TypeError: undefined is not a function' },
});

function mount(node: React.ReactElement): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => { root?.render(node); });
}

describe('TriageEvidenceDisclosureProvider', () => {
  it('routes a source disclosure to the one parent-owned consumer and hands the source no composer', async () => {
    const disclose = vi.fn(async (
      resolve: (signal: AbortSignal) => Promise<TriageEvidenceCandidateV1 | null>,
    ): Promise<TriageEvidenceDisclosureOutcomeV1> => {
      const disclosed = await resolve(new AbortController().signal);
      return disclosed === null ? { kind: 'cancelled' } : { kind: 'applied' };
    });
    let seen: readonly string[] = [];
    let outcome: TriageEvidenceDisclosureOutcomeV1 | null = null;

    function SourceDetail(): React.ReactElement {
      const disclosure = useTriageEvidenceDisclosure();
      seen = Object.keys(disclosure).sort();
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
      <TriageEvidenceDisclosureProvider disclosure={{ available: true, disclose }}>
        <SourceDetail />
      </TriageEvidenceDisclosureProvider>,
    );
    await act(async () => { container?.querySelector('button')?.click(); });

    expect(disclose).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'applied' });
    // The whole surface a source is handed. A composer ref, handle, snapshot or
    // revision appearing here would make every source its own draft writer.
    expect(seen).toEqual(['available', 'disclose']);
  });

  it('runs no source-side selection when no Triage parent is mounted', async () => {
    // A source detail can be mounted outside the aggregate. Opening its own
    // picker for a disclosure that can reach no draft would show the reader a
    // choice whose result is discarded, so the resolver is never invoked.
    const resolve = vi.fn(async () => CANDIDATE);
    let outcome: TriageEvidenceDisclosureOutcomeV1 | null = null;
    let available: boolean | null = null;

    function SourceDetail(): React.ReactElement {
      const disclosure = useTriageEvidenceDisclosure();
      available = disclosure.available;
      return (
        <button onClick={() => { void disclosure.disclose(resolve).then((result) => { outcome = result; }); }}>
          disclose
        </button>
      );
    }

    mount(<SourceDetail />);
    await act(async () => { container?.querySelector('button')?.click(); });

    expect(available).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'inert' });
  });
});
