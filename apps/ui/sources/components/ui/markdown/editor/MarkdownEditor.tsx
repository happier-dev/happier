/**
 * Base `MarkdownEditor` entry (D1 / R-A16 / R18).
 *
 * Unlike `CodeEditor.tsx` (which uses a runtime `Platform.OS` `require` router and
 * therefore statically bundles BOTH platform branches), `MarkdownEditor` relies on
 * platform-suffix resolution to FULLY exclude every `@tiptap/*` import from the
 * native RN JS graph:
 *
 *  - This base file re-exports the NATIVE variant (`MarkdownEditor.native`), which
 *    imports NO `@tiptap/*`. So Node/Vitest (and any non-Metro consumer) resolve a
 *    TipTap-free module — tests can import `./MarkdownEditor` safely.
 *  - Metro overrides this base with `MarkdownEditor.web.tsx` on web (→ the
 *    `@tiptap/react` surface) and `MarkdownEditor.native.tsx` on iOS/Android (→ the
 *    WebView surface). The web TipTap branch is therefore never pulled into the
 *    native bundle.
 *
 * Tests that need a concrete surface import the `.web`/`.native` file directly.
 */
export * from './MarkdownEditor.native';
