import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { readRpcErrorCode, RPC_ERROR_CODES } from '../rpc/errors.js';
import { DaemonWorkspaceFileSearchResponseSchema, type DaemonWorkspaceFileSearchRequest, type DaemonWorkspaceFileSearchResponse } from './workspaceFiles.js';

const relativePath = z.string().check(z.minLength(1), z.refine(path => !path.startsWith('/') && !path.includes('\\')
  && !/^[A-Za-z]:/u.test(path) && path.split('/').every(part => part !== '..' && part !== '.' && part.length > 0)));
const coordinate = z.number().check(z.int(), z.nonnegative());
const position = z.strictObject({ line: coordinate, character: coordinate });
const range = z.strictObject({ start: position, end: position });
export const CODE_IDENTIFIER_PATTERN = '[$_\\p{ID_Start}][$_\\u200c\\u200d\\p{ID_Continue}]*';
const identifierPattern = new RegExp(`^(?:${CODE_IDENTIFIER_PATTERN})$`, 'u');
const identifierContinuation = /[$_\u200c\u200d\p{ID_Continue}]/u;
export function isCodeIdentifier(value: string): boolean { return identifierPattern.test(value); }
export const CodeIntelligenceFallbackInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.trim(), z.minLength(1)), path: relativePath,
  kind: z.enum(['definition', 'references']), line: z.number().check(z.int(), z.positive()),
  symbol: z.string().check(z.refine(isCodeIdentifier)),
  languageId: z.optional(z.string().check(z.minLength(1))),
}));
export type CodeIntelligenceFallbackInput = z.infer<typeof CodeIntelligenceFallbackInputSchema>;
export const CodeIntelligenceFallbackLocationSchema = lazyZodSchema(() => z.strictObject({ path: relativePath, range, lineText: z.string() }));
export type CodeIntelligenceFallbackLocation = z.infer<typeof CodeIntelligenceFallbackLocationSchema>;
export const CodeIntelligenceFallbackResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), source: z.literal('text_matches'), locations: z.array(CodeIntelligenceFallbackLocationSchema),
    hasMore: z.boolean(), coverage: z.enum(['complete', 'partial']) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.string().check(z.minLength(1)) }),
]));
export type CodeIntelligenceFallbackResult = z.infer<typeof CodeIntelligenceFallbackResultSchema>;

// Portable declaration data is shared by UI and Action callers. It is approximate
// name search, never a semantic claim or a second Machine search implementation.
const DECLARATION_FAMILIES = [
  { languageIds: ['typescript', 'tsx', 'javascript', 'jsx', 'typescriptreact', 'javascriptreact'], extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'], pattern: '(?:function|class|interface|type|enum|namespace|const|let|var)[ \\t]+{symbol}' },
  { languageIds: ['python'], extensions: ['py', 'pyi'], pattern: '(?:def|class)[ \\t]+{symbol}|^[ \\t]*{symbol}[ \\t]*=' },
  { languageIds: ['rust'], extensions: ['rs'], pattern: '(?:fn|struct|enum|trait|type|mod|const|static|let)[ \\t]+{symbol}' },
  { languageIds: ['go'], extensions: ['go'], pattern: '(?:func|type|var|const)[ \\t]+{symbol}' },
  { languageIds: ['ruby'], extensions: ['rb'], pattern: '(?:def|class|module)[ \\t]+{symbol}' },
  { languageIds: ['java', 'kotlin', 'scala', 'c', 'cpp', 'csharp', 'swift', 'php'], extensions: ['java', 'kt', 'scala', 'c', 'h', 'cc', 'cpp', 'cs', 'swift', 'php'], pattern: '(?:class|interface|struct|enum|trait|type|func|fun|function|val|var)[ \\t]+{symbol}|{symbol}[ \\t]*\\(' },
] as const;
const GENERIC_DECLARATION = '(?:function|class|interface|type|enum|namespace|const|let|var|def|fn|struct|trait|func|fun|module)[ \\t]+{symbol}';
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function searchPattern(input: CodeIntelligenceFallbackInput): string {
  const escaped = escapeRegex(input.symbol);
  // Native rg's Unicode word class differs from identifier grammar ($, marks,
  // Other_ID_Start). Consume only a leading boundary so adjacent tokens are
  // found; the canonical identifier check below enforces the trailing boundary.
  if (input.kind === 'references') return `(?:^|[^$_\\p{ID_Continue}\u200c\u200d])${escaped}`;
  const extension = input.path.split('.').at(-1)?.toLowerCase();
  const family = DECLARATION_FAMILIES.find(item => (item.languageIds as readonly string[]).includes(input.languageId ?? '')
    || (!input.languageId && (item.extensions as readonly string[]).includes(extension ?? '')));
  return (family?.pattern ?? GENERIC_DECLARATION).replaceAll('{symbol}', escaped);
}
function proximity(source: string, target: string): number {
  const left = source.split('/').slice(0, -1); const right = target.split('/').slice(0, -1);
  let common = 0;
  while (common < left.length && common < right.length && left[common] === right[common]) common++;
  return left.length + right.length - 2 * common;
}
export type CodeIntelligenceFallbackSearch = (request: DaemonWorkspaceFileSearchRequest) => Promise<DaemonWorkspaceFileSearchResponse
  | Readonly<{ ok: false; errorCode: string; error?: string }>>;

export async function queryCodeIntelligenceFallback(rawInput: CodeIntelligenceFallbackInput, search: CodeIntelligenceFallbackSearch): Promise<CodeIntelligenceFallbackResult> {
  const input = CodeIntelligenceFallbackInputSchema.parse(rawInput);
  let response: Awaited<ReturnType<CodeIntelligenceFallbackSearch>>;
  try {
    response = await search({ rootPath: input.rootPath, query: searchPattern(input), regex: true, matchCase: true, contextLines: 0 });
  } catch (error) {
    const code = readRpcErrorCode(error);
    if (code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE || code === RPC_ERROR_CODES.METHOD_NOT_FOUND || code === RPC_ERROR_CODES.UPDATE_REQUIRED) {
      return { status: 'unavailable', reason: 'update_required' };
    }
    throw error;
  }
  if (!response.ok && 'errorCode' in response) return { status: 'unavailable', reason: response.errorCode === 'method_unavailable' ? 'update_required' : response.errorCode };
  const parsed = DaemonWorkspaceFileSearchResponseSchema.safeParse(response);
  if (!parsed.success) return { status: 'unavailable', reason: 'invalid_response' };
  if (!parsed.data.ok) return { status: 'unavailable', reason: parsed.data.code };
  const locations: CodeIntelligenceFallbackLocation[] = [];
  const seen = new Set<string>();
  for (const file of parsed.data.files) {
    if (!relativePath.safeParse(file.path).success) continue;
    for (const match of file.matches) {
      const start = match.column16 - 1;
      let offset = match.text.indexOf(input.symbol, start);
      while (offset >= start && offset < start + match.length16) {
        const end = offset + input.symbol.length;
        const before = offset > 0 ? match.text.codePointAt(offset - (/[\uDC00-\uDFFF]/u.test(match.text[offset - 1]!) ? 2 : 1)) : undefined;
        const after = match.text.codePointAt(end);
        if ((before === undefined || !identifierContinuation.test(String.fromCodePoint(before)))
          && (after === undefined || !identifierContinuation.test(String.fromCodePoint(after)))) {
          const key = JSON.stringify([file.path, match.line, offset]);
          if (!seen.has(key)) { seen.add(key); locations.push({ path: file.path,
            range: { start: { line: match.line - 1, character: offset }, end: { line: match.line - 1, character: end } }, lineText: match.text }); }
        }
        offset = match.text.indexOf(input.symbol, end);
      }
    }
  }
  locations.sort((left, right) => Number(right.path === input.path) - Number(left.path === input.path)
    || proximity(input.path, left.path) - proximity(input.path, right.path)
    || left.path.localeCompare(right.path)
    || Math.abs(left.range.start.line + 1 - input.line) - Math.abs(right.range.start.line + 1 - input.line)
    || left.range.start.character - right.range.start.character);
  return { status: 'ok', source: 'text_matches', locations, hasMore: parsed.data.hasMore, coverage: parsed.data.coverage };
}
