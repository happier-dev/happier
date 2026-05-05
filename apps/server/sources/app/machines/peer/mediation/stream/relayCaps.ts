import {
    MachineLiveStreamRelayCapsV1Schema,
    type MachineLiveStreamRelayCaps,
} from '@happier-dev/protocol';

export function normalizeMachineLiveStreamRelayCaps(raw: unknown): MachineLiveStreamRelayCaps | null {
    const parsed = MachineLiveStreamRelayCapsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export function hasMachineLiveStreamRelayCaps(caps: MachineLiveStreamRelayCaps | null | undefined): boolean {
    return normalizeMachineLiveStreamRelayCaps(caps) !== null;
}
