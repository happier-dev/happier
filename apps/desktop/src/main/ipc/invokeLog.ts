import { appendFile } from 'node:fs/promises';

/**
 * Records every command the renderer invokes.
 *
 * The evaluation this target exists for needs the real boot-time command list, not the inventory of
 * everything the product could theoretically call, so the host logs each invoke with its outcome.
 * Set `HAPPIER_DESKTOP_INVOKE_LOG=<path>` to also append one JSON object per line to a file.
 */

export type InvokeOutcomeKind = 'implemented' | 'not-implemented' | 'failed';

export type InvokeLogEntry = Readonly<{
    at: string;
    command: string;
    argKeys: readonly string[];
    outcome: InvokeOutcomeKind;
    /** Origin and path of an http-plugin request, so boot traffic is attributable. Never headers or query. */
    target?: string;
    /** Present only for `not-implemented`: whether the Tauri target registers this command. */
    knownToTauriTarget?: boolean;
    error?: string;
}>;

export class InvokeLog {
    private readonly counts = new Map<string, number>();

    constructor(private readonly filePath: string | null) {}

    static fromEnvironment(readEnv: (key: string) => string | undefined = (k) => process.env[k]): InvokeLog {
        const filePath = readEnv('HAPPIER_DESKTOP_INVOKE_LOG')?.trim();
        return new InvokeLog(filePath ? filePath : null);
    }

    record(entry: InvokeLogEntry): void {
        this.counts.set(entry.command, (this.counts.get(entry.command) ?? 0) + 1);

        const target = entry.target ? ` ${entry.target}` : '';
        const suffix = entry.outcome === 'implemented' ? '' : ` (${entry.outcome}${entry.error ? `: ${entry.error}` : ''})`;
        console.log(`[invoke] ${entry.command}${target}${suffix}`);

        if (this.filePath === null) return;
        void appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8').catch((error: unknown) => {
            console.error('[invoke] failed to append to invoke log', error);
        });
    }

    /** Command name -> invoke count, in first-seen order. */
    snapshot(): ReadonlyMap<string, number> {
        return new Map(this.counts);
    }
}
