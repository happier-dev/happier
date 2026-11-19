import { QualifiedProviderAccountUsageHistoryResponseV4Schema, ProviderAccountUsageReadErrorV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { createUsageNdjsonFramer } from '@happier-dev/protocol/usage/usageNdjson';

/** A finite history stream is complete only after its terminal cursor frame. */
export async function consumeProviderAccountUsageHistoryStream(response: Response,
    onPage: (page: ReturnType<typeof QualifiedProviderAccountUsageHistoryResponseV4Schema.parse>) => Promise<void>,
    options: Readonly<{ signal?: AbortSignal; assertCurrent?: () => void }>): Promise<void> {
    let complete = false;
    const admit = async (line: string) => {
        throwIfAborted(options.signal); options.assertCurrent?.();
        if (!/\S/.test(line)) return;
        if (complete) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
        const page = QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(JSON.parse(line));
        await onPage(page);
        complete = page.nextCursor === null;
    };
    const reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : undefined;
    const framer = createUsageNdjsonFramer();
    if (!reader) {
        // Native fetch can expose only a completed body. Decode each frame
        // without building another array of every line in that body.
        for (const line of framer.write(await response.text())) await admit(line);
        const line = framer.finish();
        if (line !== undefined) await admit(line);
    } else {
        const decoder = new TextDecoder();
        try {
            while (true) {
                const chunk = await reader.read();
                throwIfAborted(options.signal); options.assertCurrent?.();
                for (const line of framer.write(decoder.decode(chunk.value, { stream: !chunk.done }))) await admit(line);
                if (chunk.done) break;
            }
            const line = framer.finish();
            if (line !== undefined) await admit(line);
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
    throwIfAborted(options.signal); options.assertCurrent?.();
    if (!complete) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
}
