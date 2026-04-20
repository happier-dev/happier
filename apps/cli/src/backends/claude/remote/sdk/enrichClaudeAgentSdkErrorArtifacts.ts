import { readTailTextFile } from '@/utils/fs/readTailTextFile';

export async function enrichClaudeAgentSdkErrorArtifacts(params: {
    error: unknown;
    debugFilePath: string | undefined;
    stderrFilePath: string | undefined;
    maxBytes: number;
}) {
    const { error } = params;
    if (!error || typeof error !== 'object') return;

    const err = error as any;
    const existing = err.happierClaudeCodeArtifacts;
    const artifacts =
        existing && typeof existing === 'object' && !Array.isArray(existing)
            ? (existing as Record<string, unknown>)
            : ({} as Record<string, unknown>);

    if (artifacts.debugFilePath === undefined) artifacts.debugFilePath = params.debugFilePath ?? null;
    if (artifacts.stderrFilePath === undefined) artifacts.stderrFilePath = params.stderrFilePath ?? null;

    const debugPath = typeof artifacts.debugFilePath === 'string' ? artifacts.debugFilePath : null;
    const stderrPath = typeof artifacts.stderrFilePath === 'string' ? artifacts.stderrFilePath : null;

    if (typeof artifacts.debugTail !== 'string') {
        artifacts.debugTail = debugPath
            ? await readTailTextFile({ path: debugPath, maxBytes: params.maxBytes }).catch(() => '')
            : '';
    }
    if (typeof artifacts.stderrTail !== 'string') {
        artifacts.stderrTail = stderrPath
            ? await readTailTextFile({ path: stderrPath, maxBytes: params.maxBytes }).catch(() => '')
            : '';
    }

    err.happierClaudeCodeArtifacts = artifacts;
}
