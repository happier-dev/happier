import { createInterface } from 'node:readline';

export type ConfirmDiscardIo = Readonly<{
    isTty: boolean;
    write: (chunk: string) => void;
    question: (prompt: string) => Promise<string>;
}>;

export type ConfirmDiscardQueuedMessagesParams = Readonly<{
    queuedCount: number;
    queuedPreview: readonly string[];
    serverCount: number;
    serverPreview: readonly string[];
    io?: ConfirmDiscardIo;
}>;

function createNodeIo(): ConfirmDiscardIo {
    return {
        isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        write: (chunk: string) => {
            process.stdout.write(chunk);
        },
        question: async (prompt: string) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
                return await new Promise<string>((resolve) => rl.question(prompt, resolve));
            } finally {
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
}): Promise<boolean> {
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

    const answer = await io.question('Discard these messages and switch to local mode? (y/N) ');
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
    });
}
