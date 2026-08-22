import {
  triagePagedPanelInitialState,
  triagePagedPanelReducer,
} from '@happier-dev/triage-protocol/v1';
import type {
  TriagePagedPanelEventV1,
  TriagePagedPanelPageV1,
  TriagePagedPanelStateV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * Azure DevOps's binding of the shared Triage paged-panel state machine.
 *
 * The four-outcome rule — provider-stated empty, first read failed, later page
 * failed over visible rows, walk stopped short — is one product contract for every
 * Triage source and lives at `@happier-dev/triage-protocol`. What Azure
 * supplies is its own vocabulary, and here that is another deliberate absence:
 * Azure publishes no short-walk reason. A collection continues while it issues a
 * position and ends when it does not, so `TIncomplete` is `never`.
 *
 * Only two Azure planes page at all. `Iterations`, `Policies` and `Threads` are
 * single reads by the provider's own design — the documented thread endpoint
 * returns every thread and publishes no cursor — so they use the settled-read
 * state below rather than a walk that could never advance.
 */

/** A read that settles once for the lifetime that owns it. */
export type AzureReadStateV1<T> =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; value: T }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

export type AzurePagedStateV1<TRow> = TriagePagedPanelStateV1<TRow, TriageSourceFailureV1>;
export type AzurePagedPageV1<TRow> = TriagePagedPanelPageV1<TRow>;
export type AzurePagedEventV1<TRow> = TriagePagedPanelEventV1<TRow, TriageSourceFailureV1>;

export function azurePagedInitialState<TRow>(): AzurePagedStateV1<TRow> {
  return triagePagedPanelInitialState<TRow, TriageSourceFailureV1>();
}

export function azurePagedReducer<TRow>(
  state: AzurePagedStateV1<TRow>,
  event: AzurePagedEventV1<TRow>,
): AzurePagedStateV1<TRow> {
  return triagePagedPanelReducer<TRow, TriageSourceFailureV1>(state, event);
}

/**
 * The changes walk's position, carried through the shared reducer's one string
 * cursor slot.
 *
 * Both numbers are Azure's own `nextSkip` and `nextTop`; this is a transport
 * for them, not a computed offset. Nothing here adds to either value, which is
 * the whole rule the `Files` tab has to keep.
 */
export function encodeAzureChangesPosition(
  position: Readonly<{ nextSkip: number; nextTop: number }>,
): string {
  return `${String(position.nextSkip)}:${String(position.nextTop)}`;
}

export function decodeAzureChangesPosition(
  cursor: string,
): Readonly<{ skip: number; top: number }> | null {
  const [rawSkip, rawTop, ...rest] = cursor.split(':');
  if (rest.length > 0 || rawSkip === undefined || rawTop === undefined) return null;
  const skip = Number(rawSkip);
  const top = Number(rawTop);
  if (!Number.isSafeInteger(skip) || skip < 0) return null;
  if (!Number.isSafeInteger(top) || top < 0) return null;
  return Object.freeze({ skip, top });
}
