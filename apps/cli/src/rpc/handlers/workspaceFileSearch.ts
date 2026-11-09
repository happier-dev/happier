import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { z } from 'zod/mini';
import { run as runRipgrep } from '@/integrations/ripgrep/index';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import type { FilesystemEffectAdmission } from './fileSystem/accessPolicy/filesystemEffectAdmission';
import { authorizeFilesystemPath } from './fileSystem/accessPolicy/filesystemPathAuthorization';
import { isSafeRelativeWorkspacePath, workspaceFileExclusionArguments } from './workspaceFilePaths';
import { DaemonWorkspaceFileSearchRequestSchema, WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import type { DaemonWorkspaceFileSearchResponse, WorkspaceFileSearchFileV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

// Native rg owns this external JSON record contract. Its optional statistics are
// deliberately not part of the workspace search DTO.
const TextField = z.union([z.object({ text: z.string() }), z.object({ bytes: z.string() })]);
const PathRecord = z.object({ path: TextField });
const LineRecord = z.extend(PathRecord, { lines: TextField, line_number: z.number().check(z.int(), z.positive()),
    submatches: z.optional(z.array(z.object({ match: TextField, start: z.number().check(z.int(), z.nonnegative()), end: z.number().check(z.int(), z.nonnegative()) }))) });
const EndRecord = z.extend(PathRecord, { binary_offset: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))) });
const RecordEnvelope = z.object({ type: z.enum(['begin', 'match', 'context', 'end', 'summary']), data: z.unknown() });

type Match = WorkspaceFileSearchFileV1['matches'][number];
type ActiveFile = { path: string; lines: Map<number, string>; matches: Match[]; minimumBytes: number; oversized: boolean };

function textValue(value: z.infer<typeof TextField>): string | null {
    return 'text' in value ? value.text : null;
}

function responseBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

export function registerWorkspaceFileSearchHandler(
    registrar: RpcHandlerRegistrar,
    workingDirectory: string,
    opts?: Readonly<{ accessPolicy?: FilesystemAccessPolicy; effectAdmission?: FilesystemEffectAdmission }>,
): void {
    registrar.registerHandler<unknown, DaemonWorkspaceFileSearchResponse>(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH,
        async (raw, context) => {
            const custodyFailure = await opts?.effectAdmission?.rpc(context);
            if (custodyFailure) return { ok: false, code: custodyFailure.errorCode,
                message: custodyFailure.error, details: custodyFailure.details };
            const parsed = DaemonWorkspaceFileSearchRequestSchema.safeParse(raw);
            if (!parsed.success) return { ok: false, code: 'ripgrep_failed' };
            const request = parsed.data;
            const authorization = authorizeFilesystemPath({ targetPath: request.rootPath, defaultDirectory: workingDirectory,
                accessPolicy: opts?.accessPolicy ?? { kind: 'osUser' } });
            if (!authorization.valid) return { ok: false, code: 'root_not_allowed' };

            const contextLines = request.contextLines ?? 2;
            const files: WorkspaceFileSearchFileV1[] = [];
            const responseOverheadBytes = {
                complete: responseBytes({ ok: true, files: [], hasMore: false, coverage: 'complete' }),
                partial: responseBytes({ ok: true, files: [], hasMore: false, coverage: 'partial' }),
            };
            let filesBytes = 0;
            let active: ActiveFile | null = null;
            let coverage: 'complete' | 'partial' = 'complete';
            let hasMore = false;
            let parseFailed = false;
            let sawSummary = false;
            const consume = (line: string): boolean => {
                const record = RecordEnvelope.parse(JSON.parse(line));
                if (record.type === 'summary') { sawSummary = true; return true; }
                const rawPath = textValue(PathRecord.parse(record.data).path);
                const path = rawPath?.replace(/\\/g, '/').replace(/^\.\//u, '');
                if (!path || !isSafeRelativeWorkspacePath(path)) { coverage = 'partial'; return true; }
                if (record.type === 'begin') {
                    if (active) throw new Error('Unexpected nested ripgrep file record');
                    active = { path, lines: new Map(), matches: [], minimumBytes: responseBytes({ path, matches: [] }), oversized: false };
                    return true;
                }
                if (!active || active.path !== path) throw new Error('Ripgrep record outside its file');
                if (record.type === 'end') {
                    if (EndRecord.parse(record.data).binary_offset != null) coverage = 'partial';
                    if (!active.oversized && active.matches.length > 0) {
                        for (const match of active.matches) {
                            for (let offset = contextLines; offset > 0; offset--) {
                                const before = active.lines.get(match.line - offset);
                                if (before !== undefined) match.before.push(before);
                            }
                            for (let offset = 1; offset <= contextLines; offset++) {
                                const after = active.lines.get(match.line + offset);
                                if (after !== undefined) match.after.push(after);
                            }
                        }
                        const file = { path, matches: active.matches };
                        // Reserve the longer boolean representation so both an
                        // exhausted scan and an early-stopped page fit the ceiling.
                        const fileBytes = responseBytes(file);
                        const overheadBytes = responseOverheadBytes[coverage];
                        const separatorBytes = files.length > 0 ? 1 : 0;
                        if (overheadBytes + fileBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
                            coverage = 'partial'; // An indivisible oversized file is skipped whole.
                        } else if (overheadBytes + filesBytes + separatorBytes + fileBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
                            hasMore = true;
                            coverage = 'partial';
                            active = null;
                            return false;
                        } else {
                            files.push(file);
                            filesBytes += separatorBytes + fileBytes;
                        }
                    }
                    active = null;
                    return true;
                }
                if (active.oversized) return true;
                const data = LineRecord.parse(record.data);
                const rawText = textValue(data.lines);
                if (rawText === null) { coverage = 'partial'; return true; }
                const text = rawText.replace(/\r?\n$/u, '');
                active.lines.set(data.line_number, text);
                if (record.type === 'context') active.minimumBytes += responseBytes(text);
                if (record.type === 'match') {
                    if (!data.submatches) throw new Error('Ripgrep match without submatches');
                    const bytes = Buffer.from(text, 'utf8');
                    for (const range of data.submatches) {
                        if (range.end < range.start || range.end > bytes.byteLength) throw new Error('Invalid ripgrep byte range');
                        const prefixBytes = bytes.subarray(0, range.start);
                        const matchBytes = bytes.subarray(range.start, range.end);
                        const prefix = prefixBytes.toString('utf8');
                        const matchedText = matchBytes.toString('utf8');
                        // Byte-oriented regexes can bisect a Unicode character even
                        // when the containing line is text. Such hits have no editor range.
                        if (textValue(range.match) === null || !Buffer.from(prefix).equals(prefixBytes)
                            || !Buffer.from(matchedText).equals(matchBytes)) { coverage = 'partial'; continue; }
                        const match: Match = { line: data.line_number,
                            column16: prefix.length + 1,
                            length16: matchedText.length,
                            text, before: [], after: [] };
                        active.minimumBytes += responseBytes(match) + 1;
                        if (active.minimumBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) break;
                        active.matches.push(match);
                    }
                }
                if (active.minimumBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
                    active.oversized = true;
                    active.matches = [];
                    active.lines.clear();
                    coverage = 'partial';
                }
                return true;
            };

            try {
                // Native binary mode emits the file's binary offset rather than
                // silently skipping a recursive binary hit as an empty search.
                const result = await runRipgrep(['--no-config', '--json', '--binary', '--crlf', `-C${contextLines}`,
                    ...(request.includeHidden ? ['--hidden'] : []), ...workspaceFileExclusionArguments(),
                    ...(!request.regex ? ['--fixed-strings'] : []), ...(!request.matchCase ? ['--ignore-case'] : []), '--', request.query, '.'], {
                    cwd: authorization.resolvedPath, signal: context?.signal,
                    collectStdout: false, maxStderrBytes: WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES,
                    onStdoutLine: (line) => { try { return consume(line); } catch (error) { parseFailed = true; throw error; } },
                });
                context?.signal.throwIfAborted();
                if (result.exitCode === 127) return { ok: false, code: 'ripgrep_unavailable' };
                if (result.exitCode !== 0 && result.exitCode !== 1 && !result.stoppedEarly) {
                    if (request.regex && /regex parse error|error parsing regex/iu.test(result.stderr)) {
                        return { ok: false, code: 'invalid_pattern' };
                    }
                    if (result.exitCode !== 2 || files.length === 0) return { ok: false, code: 'ripgrep_failed' };
                    coverage = 'partial';
                }
                // A launcher or native process that produced no JSON summary is
                // not proof that the workspace was searched without matches.
                if (!result.stoppedEarly && (!sawSummary || active)) return { ok: false, code: 'ripgrep_failed' };
                return { ok: true, files, hasMore, coverage };
            } catch (error) {
                if (context?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
                if (error instanceof Error && 'code' in error && error.code === 'WORKSPACE_ROOT_NOT_FOUND') {
                    return { ok: false, code: 'root_not_found' };
                }
                return { ok: false, code: parseFailed ? 'ripgrep_failed' : 'ripgrep_unavailable' };
            }
        });
}
