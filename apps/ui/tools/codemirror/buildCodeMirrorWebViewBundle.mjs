import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import esbuild from 'esbuild';

function writeIfChanged(filePath, contents) {
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    if (existing === contents) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
    return true;
}

function chunkString(value, chunkSize) {
    const out = [];
    for (let i = 0; i < value.length; i += chunkSize) {
        out.push(value.slice(i, i + chunkSize));
    }
    return out;
}

function findRepoRoot(startDir) {
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.resolve(dir, 'package.json')) && fs.existsSync(path.resolve(dir, 'pnpm-lock.yaml')) && fs.existsSync(path.resolve(dir, 'pnpm-workspace.yaml'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(startDir, '..');
}

function createEntrySource() {
    // Note: this bundle is executed inside a WebView. Keep it browser-compatible and avoid Node globals.
    return `
import { createCodeMirrorDecorations } from ${JSON.stringify(path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../sources/components/ui/code/editor/bridge/codeMirrorDecorations.ts'))};
import { createCodeMirrorLanguageIntelligence } from ${JSON.stringify(path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../sources/components/ui/code/editor/bridge/codeMirrorLanguageIntelligence.ts'))};
import { createCodeMirrorInlineSuggestions } from ${JSON.stringify(path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../sources/components/ui/code/editor/bridge/codeMirrorInlineSuggestions.ts'))};
import { EditorState, StateField, StateEffect, Compartment, RangeSet, RangeSetBuilder, RangeValue, MapMode } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, gutter, GutterMarker, ViewPlugin, lineNumbers, keymap, drawSelection, highlightSpecialChars, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess, undo, redo, undoDepth, redoDepth, cursorCharLeft, cursorCharRight, isolateHistory } from '@codemirror/commands';
import { StreamLanguage, indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, completionStatus } from '@codemirror/autocomplete';
import { search, SearchQuery, setSearchQuery, getSearchQuery, findNext, findPrevious, openSearchPanel, closeSearchPanel } from '@codemirror/search';
import { tags } from '@lezer/highlight';

import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { sql } from '@codemirror/lang-sql';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { php } from '@codemirror/lang-php';

import { shell } from '@codemirror/legacy-modes/mode/shell';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { properties } from '@codemirror/legacy-modes/mode/properties';

const legacyShell = StreamLanguage.define(shell);
const legacyDockerfile = StreamLanguage.define(dockerFile);
const legacyToml = StreamLanguage.define(toml);
const legacyIni = StreamLanguage.define(properties);

globalThis.HAPPIER_CODEMIRROR_WEBVIEW = {
  createCodeMirrorDecorations,
  createCodeMirrorLanguageIntelligence,
  Compartment,
  createCodeMirrorInlineSuggestions,
  EditorState,
  StateField,
  StateEffect,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  MapMode,
  Decoration,
  WidgetType,
  gutter,
  GutterMarker,
  ViewPlugin,
  EditorView,
  lineNumbers,
  keymap,
  drawSelection,
  highlightSpecialChars,
  highlightActiveLine,
  highlightActiveLineGutter,
  defaultKeymap,
  history,
  historyKeymap,
  indentMore, indentLess, undo, redo, undoDepth, redoDepth, cursorCharLeft, cursorCharRight, isolateHistory,
  indentOnInput,
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
  tags,
  closeBrackets,
  completionStatus,
  closeBracketsKeymap,
  search,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext,
  findPrevious,
  openSearchPanel,
  closeSearchPanel,
  langs: {
    javascript,
    python,
    markdown,
    json,
    yaml,
    shell: () => legacyShell,
    dockerfile: () => legacyDockerfile,
    toml: () => legacyToml,
    ini: () => legacyIni,
    css,
    scss: css,
    less: css,
    html,
    xml,
    sql,
    rust,
    go,
    java,
    cpp,
    php,
  }
};
`;
}

export async function buildCodeMirrorWebViewBundle({ expoAppDir, repoRootDir, check = false }) {
    const entry = createEntrySource();

    const result = await esbuild.build({
        absWorkingDir: expoAppDir,
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: ['es2020'],
        minify: true,
        legalComments: 'eof',
        sourcemap: false,
        treeShaking: true,
        stdin: {
            contents: entry,
            loader: 'ts',
            resolveDir: expoAppDir,
            sourcefile: 'codemirror-webview-entry.ts',
        },
    });

    const js = result.outputFiles?.[0]?.text ?? '';
    if (!js.trim()) {
        throw new Error('esbuild produced an empty CodeMirror bundle');
    }

    // Compile the same factory for the CDN path too. Serializing a Metro-transformed
    // function would lose the Babel class helpers captured outside its body.
    const fallback = await esbuild.build({
        absWorkingDir: expoAppDir,
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: ['es2020'],
        minify: true,
        legalComments: 'eof',
        stdin: {
            contents: `import { createCodeMirrorInlineSuggestions } from ${JSON.stringify(path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../sources/components/ui/code/editor/bridge/codeMirrorInlineSuggestions.ts'))}; globalThis.HAPPIER_CODEMIRROR_INLINE_FACTORY = createCodeMirrorInlineSuggestions;`,
            loader: 'ts',
            resolveDir: expoAppDir,
            sourcefile: 'codemirror-inline-fallback-entry.ts',
        },
    });
    const fallbackJs = fallback.outputFiles?.[0]?.text ?? '';
    if (!fallbackJs.trim()) throw new Error('esbuild produced an empty CodeMirror inline fallback');
    const chunks = chunkString(js, 50_000);
    const ts = `/**
 * Generated by \`apps/ui/tools/codemirror/buildCodeMirrorWebViewBundle.mjs\`.
 *
 * This file exists in source control as a safe fallback so the app can still run
 * (it will fall back to CDN ESM imports when empty). Postinstall replaces it
 * with an embedded, offline-friendly bundle for native CodeMirror WebView.
 */
const CODEMIRROR_WEBVIEW_BUNDLE_CHUNKS = [
${chunks.map((chunk) => `    ${JSON.stringify(chunk)},`).join('\n')}
];

export const CODEMIRROR_WEBVIEW_BUNDLE_JS = CODEMIRROR_WEBVIEW_BUNDLE_CHUNKS.join('');
export const CODEMIRROR_INLINE_SUGGESTIONS_FACTORY_JS = ${JSON.stringify(fallbackJs)};
`;

    const outFile = path.resolve(
        expoAppDir,
        'sources',
        'components',
        'ui',
        'code',
        'editor',
        'bridge',
        'codemirrorWebViewBundle.generated.ts',
    );

    if (check && (!fs.existsSync(outFile) || fs.readFileSync(outFile, 'utf8') !== ts)) {
        throw new Error('CodeMirror WebView bundle is out of date; run its canonical generator');
    }
    const wrote = check ? false : writeIfChanged(outFile, ts);
    return { wrote, outFile, bundleBytes: Buffer.byteLength(js, 'utf8') };
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
    const toolsDir = path.dirname(fs.realpathSync(url.fileURLToPath(import.meta.url)));
    const expoAppDir = path.resolve(toolsDir, '..', '..');
    const repoRootDir = findRepoRoot(expoAppDir);

    buildCodeMirrorWebViewBundle({ expoAppDir, repoRootDir, check: process.argv.includes('--check') })
        .then((result) => {
            // eslint-disable-next-line no-console
            console.log(
                `[codemirror] webview bundle ${result.wrote ? 'written' : 'up to date'}: ${path.relative(
                    expoAppDir,
                    result.outFile,
                )} (${Math.round(result.bundleBytes / 1024)}kb)`,
            );
        })
        .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        });
}
