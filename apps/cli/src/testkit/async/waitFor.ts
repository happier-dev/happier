export type WaitForConditionOptions = {
    timeoutMs: number;
    intervalMs?: number;
    label: string;
    debug?: () => string;
};

export async function waitForCondition(
    condition: () => boolean | Promise<boolean>,
    opts: WaitForConditionOptions,
): Promise<void> {
    const intervalMs = opts.intervalMs ?? 100;
    const start = Date.now();

    while (Date.now() - start < opts.timeoutMs) {
        if (await condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    const debug = opts.debug ? `\n${opts.debug()}` : '';
    throw new Error(`Timed out waiting for ${opts.label} after ${opts.timeoutMs}ms${debug}`);
}
