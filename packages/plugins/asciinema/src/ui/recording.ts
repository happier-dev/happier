import type { PluginUiHostApi, OpenableContentRef } from '@happier-dev/plugin-sdk/ui';

// Public openable-content v1 ceiling (10 MB), not the 256 KB default.
// The SDK exposes the request type but does not export the protocol constant.
export const MAX_RECORDING_BYTES = 10_000_000;
export type RecordingResult = { status: 'ready'; text: string } | {
    status: 'invalid' | 'tooLarge' | 'unavailable' | 'unsupported' | 'cancelled' | 'changed';
};

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function recordingReference(input: unknown): OpenableContentRef | undefined {
    if (!record(input) || input.kind !== 'workspaceFile' || typeof input.handle !== 'string') return;
    return { kind: 'workspaceFile', handle: input.handle };
}

// Validate the file boundary without interpreting terminal output or metadata.
// Playback, timing, themes and escape sequences remain upstream's responsibility.
function isRecording(text: string): boolean {
    try {
        const [first, ...lines] = text.trimEnd().split('\n');
        const header: unknown = JSON.parse(first ?? '');
        if (!record(header) || (header.version !== 2 && header.version !== 3)) return false;
        const dimensions = header.version === 2 ? { cols: header.width, rows: header.height } : header.term;
        if (!record(dimensions) || !Number.isInteger(dimensions.cols) || !Number.isInteger(dimensions.rows)
            || Number(dimensions.cols) <= 0 || Number(dimensions.rows) <= 0) return false;
        for (const line of lines) {
            if (header.version === 3 && line.startsWith('#')) continue;
            const event: unknown = JSON.parse(line);
            if (!Array.isArray(event) || event.length !== 3 || typeof event[0] !== 'number'
                || !Number.isFinite(event[0]) || event[0] < 0 || typeof event[1] !== 'string'
                || typeof event[2] !== 'string') return false;
        }
        return true;
    } catch { return false; }
}

export async function readRecording(
    host: Pick<PluginUiHostApi, 'statOpenableContent' | 'readOpenableContent'>,
    ref: OpenableContentRef,
    signal?: AbortSignal,
): Promise<RecordingResult> {
    const options = signal === undefined ? undefined : { signal };
    const stat = await host.statOpenableContent(ref, options);
    if (stat.status !== 'ready') return stat;
    if (stat.sizeBytes > MAX_RECORDING_BYTES) return { status: 'tooLarge' };
    const read = await host.readOpenableContent({ ref, expectedRevision: stat.revision, maxBytes: MAX_RECORDING_BYTES }, options);
    if (read.status !== 'ready') return read;
    if (read.content.kind !== 'utf8' || !isRecording(read.content.text)) return { status: 'invalid' };
    return { status: 'ready', text: read.content.text };
}
