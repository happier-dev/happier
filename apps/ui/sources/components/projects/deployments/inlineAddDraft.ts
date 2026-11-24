import * as React from 'react';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * An open inline Add form (Add domain, Variables' Add) and what was typed into it, kept per form key for this app's
 * lifetime (device-local, in memory). A width change that recomposes the page (desktop ↔ phone shell) remounts the
 * form; the draft brings it back as it was (PAGE-ACCEPT R6-D4, R8-D3). Closing it (its open field set to false or null:
 * Cancel, a successful add) forgets it. Nothing is persisted or synced.
 */
const drafts = new Map<string, Record<string, unknown>>();

export function inlineAddDraftKey(
  scope: ServerAccountScope | null,
  environmentId: string,
  form: 'domains' | 'variables' | 'add-check',
): string | null {
  return scope ? serverAccountScopedResourceKey(scope, environmentId, form) : null;
}

export function useInlineAddDraftField<T>(
  draftKey: string | null,
  field: string,
  initial: T,
): readonly [T, (next: T | ((previous: T) => T)) => void] {
  const read = () => {
    const kept = draftKey === null ? undefined : drafts.get(draftKey);
    return { key: draftKey, value: kept && field in kept ? (kept[field] as T) : initial };
  };
  const [state, setState] = React.useState(read);
  const current = state.key === draftKey ? state : read();
  if (current !== state) setState(current);
  const set = React.useCallback(
    (next: T | ((previous: T) => T)) => {
      setState((previous) => {
        if (previous.key !== draftKey) return previous;
        const resolved =
          typeof next === 'function'
            ? (next as (previous: T) => T)(previous.value)
            : next;
        if (draftKey !== null) {
          if (field === INLINE_ADD_OPEN && (resolved === false || resolved === null)) drafts.delete(draftKey);
          else drafts.set(draftKey, { ...drafts.get(draftKey), [field]: resolved });
        }
        return { key: draftKey, value: resolved };
      });
    },
    [draftKey, field],
  );
  return [current.value, set] as const;
}

/** The field that holds whether (or which) form is open; closing it forgets the draft. */
export const INLINE_ADD_OPEN = 'open';

/** Forgets every kept draft; each test starts from a closed form. */
export function forgetInlineAddDraftsForTest(): void {
  drafts.clear();
}
