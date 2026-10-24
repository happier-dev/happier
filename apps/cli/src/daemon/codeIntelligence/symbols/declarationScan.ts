import { extname } from 'node:path';

import type { CodeIntelligenceSymbolKindV1 } from '@happier-dev/protocol';

/**
 * Deterministic, dependency-free declaration scanning. It recognizes declaration lines with
 * per-language patterns and bounds each declaration by indentation, so it is accurate for
 * conventionally formatted code and silent (never inventive) for anything else. Results are
 * labeled `declaration_scan` so no consumer mistakes them for compiler-grade structure; a
 * Tree-sitter backed scanner can replace this owner without changing its callers.
 */
export type ScannedDeclaration = Readonly<{
  name: string;
  /** Names of enclosing declarations joined with `.`, e.g. `Cart.clear`. */
  qualifiedName: string;
  kind: CodeIntelligenceSymbolKindV1;
  startLine: number;
  endLine: number;
}>;

type LanguageId = 'typescript' | 'python' | 'rust' | 'go' | 'jvm';

const LANGUAGE_BY_EXTENSION: Record<string, LanguageId> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'jvm',
  '.kt': 'jvm',
  '.cs': 'jvm',
};

export function resolveScannableLanguage(path: string): LanguageId | null {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

type DeclarationMatch = Readonly<{ name: string; kind: CodeIntelligenceSymbolKindV1 }>;
type LineMatcher = (line: string, indent: number) => DeclarationMatch | null;

const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'with', 'function', 'new', 'await', 'yield', 'typeof', 'super']);

function firstMatch(line: string, patterns: ReadonlyArray<readonly [RegExp, CodeIntelligenceSymbolKindV1]>): DeclarationMatch | null {
  for (const [pattern, kind] of patterns) {
    const match = pattern.exec(line);
    if (match?.[1]) return { name: match[1], kind };
  }
  return null;
}

const TS_PATTERNS: ReadonlyArray<readonly [RegExp, CodeIntelligenceSymbolKindV1]> = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
  [/^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, 'type'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
];
const TS_METHOD = /^\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(.*\)\s*(?::\s*[^{]+)?\{\s*$/;

const typescriptMatcher: LineMatcher = (line, indent) => {
  const declaration = firstMatch(line, TS_PATTERNS);
  if (declaration) return declaration;
  if (indent === 0) return null;
  const method = TS_METHOD.exec(line);
  if (!method?.[1] || CONTROL_KEYWORDS.has(method[1])) return null;
  return { name: method[1], kind: 'method' };
};

const pythonMatcher: LineMatcher = (line, indent) => {
  const fn = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
  if (fn?.[1]) return { name: fn[1], kind: indent > 0 ? 'method' : 'function' };
  const cls = /^\s*class\s+([A-Za-z_]\w*)/.exec(line);
  return cls?.[1] ? { name: cls[1], kind: 'class' } : null;
};

const RUST_PATTERNS: ReadonlyArray<readonly [RegExp, CodeIntelligenceSymbolKindV1]> = [
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, 'struct'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, 'enum'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/, 'trait'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{/, 'module'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, 'type'],
];

const rustMatcher: LineMatcher = (line, indent) => {
  const fn = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/.exec(line);
  if (fn?.[1]) return { name: fn[1], kind: indent > 0 ? 'method' : 'function' };
  return firstMatch(line, RUST_PATTERNS);
};

const goMatcher: LineMatcher = (line) => {
  const fn = /^func\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(line);
  if (fn?.[2]) return { name: fn[2], kind: fn[1] ? 'method' : 'function' };
  const type = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/.exec(line);
  if (type?.[1]) return { name: type[1], kind: type[2] === 'interface' ? 'interface' : 'struct' };
  return null;
};

const JVM_PATTERNS: ReadonlyArray<readonly [RegExp, CodeIntelligenceSymbolKindV1]> = [
  [/^\s*(?:(?:public|private|protected|internal|static|abstract|final|sealed|partial|open|data)\s+)*class\s+([A-Za-z_]\w*)/, 'class'],
  [/^\s*(?:(?:public|private|protected|internal|static|sealed|partial)\s+)*interface\s+([A-Za-z_]\w*)/, 'interface'],
  [/^\s*(?:(?:public|private|protected|internal|static)\s+)*enum\s+(?:class\s+)?([A-Za-z_]\w*)/, 'enum'],
  [/^\s*(?:(?:public|private|protected|internal|override|suspend|inline|open)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)/, 'function'],
];

// Java/C# methods need at least one modifier, which keeps statements and calls from matching.
const JVM_METHOD = /^\s+(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|virtual|async|sealed|partial|new|extern|unsafe|native|default)\s+)+(?:[\w<>[\],.?]+\s+)+?([A-Za-z_]\w*)\s*\(/;

const jvmMatcher: LineMatcher = (line, indent) => {
  const declaration = firstMatch(line, JVM_PATTERNS);
  if (declaration) return declaration;
  const method = indent > 0 ? JVM_METHOD.exec(line) : null;
  return method?.[1] && !CONTROL_KEYWORDS.has(method[1]) ? { name: method[1], kind: 'method' } : null;
};

const MATCHERS: Record<LanguageId, LineMatcher> = {
  typescript: typescriptMatcher,
  python: pythonMatcher,
  rust: rustMatcher,
  go: goMatcher,
  jvm: jvmMatcher,
};

function leadingWhitespaceLength(line: string): number {
  return line.length - line.trimStart().length;
}

/** A declaration's block ends before the next non-blank line indented at or below its own. */
function findBlockEnd(lines: readonly string[], startIndex: number, startIndent: number): number {
  let lastIncluded = startIndex;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = leadingWhitespaceLength(line);
    if (indent > startIndent) {
      lastIncluded = index;
      continue;
    }
    // A brace on its own line at the declaration's indent (C# and Allman style) opens its body.
    if (indent === startIndent && trimmed === '{') {
      lastIncluded = index;
      continue;
    }
    // The closing line of a multi-line signature (`): T {`, `) -> int:`) opens the body.
    if (indent === startIndent && /^\)/.test(trimmed) && /[{:]$/.test(trimmed)) {
      lastIncluded = index;
      continue;
    }
    if (indent === startIndent && /^[}\])]/.test(trimmed)) lastIncluded = index;
    break;
  }
  return lastIncluded;
}

export function scanDeclarations(input: Readonly<{ path: string; content: string }>): ScannedDeclaration[] {
  const language = resolveScannableLanguage(input.path);
  if (!language) return [];
  const matcher = MATCHERS[language];
  const lines = input.content.split(/\r?\n/);
  const raw: Array<Readonly<{ name: string; kind: CodeIntelligenceSymbolKindV1; startIndex: number; endIndex: number }>> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) continue;
    const indent = leadingWhitespaceLength(line);
    const match = matcher(line, indent);
    if (!match) continue;
    raw.push({ ...match, startIndex: index, endIndex: findBlockEnd(lines, index, indent) });
  }
  return raw.map((declaration) => {
    const parents = raw
      .filter((other) => other !== declaration && other.startIndex < declaration.startIndex && other.endIndex >= declaration.endIndex)
      .map((other) => other.name);
    return {
      name: declaration.name,
      qualifiedName: [...parents, declaration.name].join('.'),
      kind: declaration.kind,
      startLine: declaration.startIndex + 1,
      endLine: declaration.endIndex + 1,
    };
  });
}
