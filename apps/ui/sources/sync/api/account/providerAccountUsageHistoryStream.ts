import { QualifiedProviderAccountUsageHistoryResponseV4Schema, ProviderAccountUsageReadErrorV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

/** A finite history stream is complete only after its terminal cursor frame. */
export async function consumeProviderAccountUsageHistoryStream(response: Response,
    onPage: (page: ReturnType<typeof QualifiedProviderAccountUsageHistoryResponseV4Schema.parse>) => Promise<void>,
    options: Readonly<{ signal?: AbortSignal; assertCurrent?: () => void }>): Promise<void> {
    let complete = false;
    const admit = async (line: string) => {
        throwIfAborted(options.signal); options.assertCurrent?.();
        if (!line.trim()) return;
        if (complete) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
        const page = QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(JSON.parse(line));
        await onPage(page);
        complete = page.nextCursor === null;
    };
    const reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : undefined;
    if (!reader) {
        // Native fetch can expose only a completed body. Decode each frame
        // without building another array of every line in that body.
        const text = await response.text();
        let start = 0;
        while (start < text.length) {
            const newline = text.indexOf('\n', start);
            const end = newline < 0 ? text.length : newline;
            await admit(text.slice(start, end));
            start = end + 1;
        }
    } else {
        const decoder = new TextDecoder();
        let pending = '';
        try {
            while (true) {
                const chunk = await reader.read();
                throwIfAborted(options.signal); options.assertCurrent?.();
                pending += decoder.decode(chunk.value, { stream: !chunk.done });
                let newline: number;
                while ((newline = pending.indexOf('\n')) !== -1) {
                    const line = pending.slice(0, newline);
                    pending = pending.slice(newline + 1);
                    await admit(line);
                }
                if (chunk.done) break;
            }
            if (pending.trim()) await admit(pending);
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
    throwIfAborted(options.signal); options.assertCurrent?.();
    if (!complete) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
}
