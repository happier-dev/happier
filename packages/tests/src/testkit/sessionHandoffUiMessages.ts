import { readFile } from 'node:fs/promises';

import { fetchJson } from './http';

export async function postPlainUiTextMessage(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    text: string;
    localId: string;
}>): Promise<void> {
    const response = await fetchJson<{ didWrite?: boolean }>(`${params.baseUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            localId: params.localId,
            content: {
                t: 'plain',
                v: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: params.text,
                    },
                },
            },
        }),
        timeoutMs: 15_000,
    });
    if (response.status !== 200 || response.data?.didWrite !== true) {
        throw new Error(`Failed to post plaintext UI message for session ${params.sessionId} (status=${response.status})`);
    }
}

export async function fakeClaudeLogContainsUserText(logPath: string, text: string): Promise<boolean> {
    const raw = await readFile(logPath, 'utf8').catch(() => '');
    if (!raw) return false;
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .some((line) => {
            try {
                const parsed = JSON.parse(line) as { type?: unknown; userTextPreview?: unknown };
                return parsed.type === 'sdk_stdin'
                    && typeof parsed.userTextPreview === 'string'
                    && parsed.userTextPreview.includes(text);
            } catch {
                return false;
            }
        });
}
