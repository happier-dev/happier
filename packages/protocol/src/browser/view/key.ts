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
