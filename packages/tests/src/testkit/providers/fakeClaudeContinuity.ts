import { readFile } from 'node:fs/promises';

import { decryptLegacyBase64 } from '../messageCrypto';
import { fetchSessionV2 } from '../sessions';

type FakeClaudeLogEntry = {
    type?: unknown;
    mode?: unknown;
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
