import { readFile, writeFile } from 'node:fs/promises';

import { decryptLegacyBase64 } from '../messageCrypto';
import { fetchSessionV2 } from '../sessions';
import { waitFor } from '../timing';

type FakeClaudeLogEntry = {
    type?: unknown;
    mode?: unknown;
    pid?: unknown;
    sessionId?: unknown;
    turn?: unknown;
    hasUserText?: unknown;
    userTextPreview?: unknown;
};

type ReadFakeClaudeSessionIdParams = {
    baseUrl: string;
    token: string;
    sessionId: string;
    secret: Uint8Array;
};

function parseJsonl(raw: string): FakeClaudeLogEntry[] {
    return raw
        .split('\n')
        .map((line: string) => line.trim())
        .filter(Boolean)
        .flatMap((line: string) => {
            try {
                return [JSON.parse(line) as FakeClaudeLogEntry];
            } catch {
                return [];
            }
        });
}

export async function readFakeClaudeSdkInvocationCount(logPath: string): Promise<number> {
    const raw = await readFile(logPath, 'utf8').catch(() => '');
    return parseJsonl(raw).filter((entry: FakeClaudeLogEntry) => entry.type === 'invocation' && entry.mode === 'sdk').length;
}

export type FakeClaudeRuntimeContinuityEvidence = Readonly<{
    sdkInvocationCount: number;
    sdkProviderPids: readonly number[];
    userPromptPreviews: readonly string[];
    providerEffectEntries: readonly Readonly<{
        pid: number;
        sessionId: string;
        turn: number;
        userTextPreview: string;
    }>[];
}>;

export async function readFakeClaudeRuntimeContinuityEvidence(
    logPath: string,
): Promise<FakeClaudeRuntimeContinuityEvidence> {
    const raw = await readFile(logPath, 'utf8').catch(() => '');
    const entries = parseJsonl(raw);
    const sdkInvocations = entries.filter(
        (entry) => entry.type === 'invocation' && entry.mode === 'sdk',
    );
    return {
        sdkInvocationCount: sdkInvocations.length,
        sdkProviderPids: sdkInvocations.flatMap((entry) => (
            typeof entry.pid === 'number' && Number.isInteger(entry.pid) && entry.pid > 0
                ? [entry.pid]
                : []
        )),
        userPromptPreviews: entries.flatMap((entry) => (
            entry.type === 'sdk_stdin'
            && entry.hasUserText === true
            && typeof entry.userTextPreview === 'string'
                ? [entry.userTextPreview]
                : []
        )),
        providerEffectEntries: entries.flatMap((entry) => (
            entry.type === 'runtime_continuity_provider_effect_entered'
            && typeof entry.pid === 'number'
            && Number.isInteger(entry.pid)
            && entry.pid > 0
            && typeof entry.sessionId === 'string'
            && typeof entry.turn === 'number'
            && Number.isInteger(entry.turn)
            && entry.turn > 0
            && typeof entry.userTextPreview === 'string'
                ? [{
                    pid: entry.pid,
                    sessionId: entry.sessionId,
                    turn: entry.turn,
                    userTextPreview: entry.userTextPreview,
                }]
                : []
        )),
    };
}

export async function waitForFakeClaudeRuntimeContinuityEffect(params: Readonly<{
    logPath: string;
    promptMarker: string;
    timeoutMs?: number;
}>): Promise<FakeClaudeRuntimeContinuityEvidence['providerEffectEntries'][number]> {
    let matchingEntry: FakeClaudeRuntimeContinuityEvidence['providerEffectEntries'][number] | null = null;
    await waitFor(async () => {
        const evidence = await readFakeClaudeRuntimeContinuityEvidence(params.logPath);
        matchingEntry = evidence.providerEffectEntries.find(
            (entry) => entry.userTextPreview.includes(params.promptMarker),
        ) ?? null;
        return matchingEntry !== null;
    }, {
        timeoutMs: params.timeoutMs ?? 60_000,
        intervalMs: 25,
        context: `fake Claude provider effect ${params.promptMarker}`,
    });
    if (!matchingEntry) {
        throw new Error(`Missing fake Claude provider effect entry for ${params.promptMarker}`);
    }
    return matchingEntry;
}

export async function releaseFakeClaudeRuntimeContinuityTurn(releaseFilePath: string): Promise<void> {
    await writeFile(releaseFilePath, 'release\n', { encoding: 'utf8', mode: 0o600 });
}

export async function readFakeClaudeSessionId(params: ReadFakeClaudeSessionIdParams): Promise<string | null> {
    const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
    const metadata = decryptLegacyBase64(snap.metadata, params.secret) as { claudeSessionId?: unknown } | null;
    return typeof metadata?.claudeSessionId === 'string' ? metadata.claudeSessionId : null;
}

export function assertPidAlive(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`Expected a positive integer PID, got ${String(pid)}`);
    }
    try {
        process.kill(pid, 0);
    } catch (error) {
        throw new Error(`Expected PID ${pid} to still be alive: ${error instanceof Error ? error.message : String(error)}`);
    }
}
