export function hashStringToPositiveInt(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash) + value.charCodeAt(index);
        hash &= hash;
    }
    return Math.abs(hash);
}

export function createSeededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state += 0x6D2B79F5;
        let next = state;
        next = Math.imul(next ^ (next >>> 15), next | 1);
        next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
        return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
    };
}

export function pickSeeded<T>(values: readonly T[], random: () => number): T {
    if (values.length === 0) {
        throw new Error('pickSeeded requires at least one value');
    }
    return values[Math.floor(random() * values.length) % values.length];
}
