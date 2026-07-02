// Platform-resolved entry for TypeScript.
// Metro / Webpack pick `.native.ts` (native) or `.web.ts` (web) automatically
// because of file extension precedence; this `.ts` file is the TS-resolvable
// shim consumers import from. See the matching pattern in
// `useComposerKeyboardLayout.ts`.
export { useTextInputCaretRect } from './useTextInputCaretRect.native';
export type {
    CaretRect,
    TextInputCaretRectHandle,
    UseTextInputCaretRectInput,
} from './useTextInputCaretRect.types';
