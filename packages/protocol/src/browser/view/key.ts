/**
 * Canonical browser view-identity map key.
 *
 * SB-D: ten owners across the UI sync domain, the daemon browser tree and the sidecar each composed
 * `(browserSessionId, viewId)` into a string map key with three different separators — NUL, `:` and
 * a plain space. Every one of them was collision-capable: view and session ids are
 * `z.string().trim().min(1).max(256)` (`view/v1.ts`), which permits the separator character inside a
 * component, so `{'a b', 'c'}` and `{'a', 'b c'}` produced the same space-separated key — and
 * therefore the same automation controller entry and the same diagnostics bucket.
 *
 * The encoding is length-prefixed, which makes it injective for *any* component content: two distinct
 * component tuples can never produce the same key. Keys are opaque — nothing in either corridor parses
 * one back — so the only contract is determinism and injectivity.
 *
 * `scope` further scopes the key (machine id, ingest source id, navigation generation …) without
 * letting a second composition owner reappear.
 */
function encodeKeyPart(part: string): string {
  return `${part.length}:${part}`;
}

export function browserViewKey(
  input: Readonly<{ browserSessionId: string; viewId: string }>,
  ...scope: readonly (string | number)[]
): string {
  let key = encodeKeyPart(input.browserSessionId) + encodeKeyPart(input.viewId);
  for (const part of scope) {
    key += encodeKeyPart(typeof part === 'number' ? String(part) : part);
  }
  return key;
}

/**
 * The daemon-derived browser context id: a view key further scoped by navigation generation.
 *
 * F2: two owners composed this by hand as `` `${browserSessionId} ${viewId} ${navigationGeneration}` ``
 * — `daemon/browser/context/routes.ts` (the fallback when a caller omits `contextId`) and
 * `daemon/browser/automation/adapters/controlBridge.ts` (unconditionally). The result is the primary
 * map key of the browser context store (`context/store.ts` `itemsByContextId`), and a space is legal
 * inside an id, so `{sid:'a b', viewId:'c', gen:1}` and `{sid:'a', viewId:'b c', gen:1}` keyed the
 * same entry: one capture silently overwrote the other's context item, and clearing one removed the
 * wrong one. Same collision class, same separator, as the eleven owners `browserViewKey` collapsed.
 *
 * A caller-supplied `contextId` is still honoured verbatim; only the derived value comes from here.
 */
export function browserViewContextId(
  input: Readonly<{ browserSessionId: string; viewId: string; navigationGeneration: number }>,
): string {
  return browserViewKey(input, input.navigationGeneration);
}
