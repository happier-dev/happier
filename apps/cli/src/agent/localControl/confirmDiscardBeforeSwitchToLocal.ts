import { createInterface } from 'node:readline';

export type ConfirmDiscardIo = Readonly<{
    isTty: boolean;
    write: (chunk: string) => void;
    question: (prompt: string, signal?: AbortSignal) => Promise<string>;
}>;

export type ConfirmDiscardQueuedMessagesParams = Readonly<{
    queuedCount: number;
    queuedPreview: readonly string[];
    serverCount: number;
    serverPreview: readonly string[];
    io?: ConfirmDiscardIo;
    signal?: AbortSignal;
}>;

function createNodeIo(): ConfirmDiscardIo {
    return {
        isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        write: (chunk: string) => {
            process.stdout.write(chunk);
        },
        question: async (prompt: string, signal?: AbortSignal) => {
            if (signal?.aborted) return '';
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            let onAbort: (() => void) | undefined;
            try {
                return await new Promise<string>((resolve) => {
                    onAbort = () => resolve('');
                    signal?.addEventListener('abort', onAbort, { once: true });
                    rl.question(prompt, resolve);
                });
            } finally {
                if (onAbort) signal?.removeEventListener('abort', onAbort);
                rl.close();
            }
        },
    };
}

function renderPreview(messages: readonly string[]): string {
    return messages
        .filter((m) => typeof m === 'string' && m.trim().length > 0)
        .slice(0, 3)
        .map((m, i) => `  ${i + 1}. ${m.length > 120 ? `${m.slice(0, 120)}…` : m}`)
        .join('\n');
}

export async function confirmDiscardBeforeSwitchToLocal(opts: {
    queuedCount: number;
    queuedPreview: readonly string[];
    pendingCount: number;
    pendingPreview: readonly string[];
    io?: ConfirmDiscardIo;
    signal?: AbortSignal;
}): Promise<boolean> {
    if (opts.signal?.aborted) return false;
    const io = opts.io ?? createNodeIo();
    if (opts.queuedCount === 0 && opts.pendingCount === 0) {
        return true;
    }

    if (!io.isTty) {
        // Without a TTY we cannot ask the user; fail closed if discarding would lose content.
        return false;
    }

    const blocks: string[] = [];
    if (opts.pendingCount > 0) {
        const preview = renderPreview(opts.pendingPreview);
        blocks.push(preview
            ? `Pending UI messages (${opts.pendingCount}):\n${preview}`
            : `Pending UI messages (${opts.pendingCount}).`);
    }
    if (opts.queuedCount > 0) {
        const preview = renderPreview(opts.queuedPreview);
        blocks.push(preview
            ? `Queued remote messages (${opts.queuedCount}):\n${preview}`
            : `Queued remote messages (${opts.queuedCount}).`);
    }

    if (blocks.length > 0) {
        io.write(`\n${blocks.join('\n\n')}\n\n`);
    }

    const answer = await io.question('Discard these messages and switch to local mode? (y/N) ', opts.signal);
    if (opts.signal?.aborted) return false;
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
}

export async function confirmDiscardQueuedMessagesForSwitchToLocal(
    opts: ConfirmDiscardQueuedMessagesParams,
): Promise<boolean> {
    return confirmDiscardBeforeSwitchToLocal({
        queuedCount: opts.queuedCount,
        queuedPreview: opts.queuedPreview,
        pendingCount: opts.serverCount,
        pendingPreview: opts.serverPreview,
        io: opts.io,
        signal: opts.signal,
    });
}
