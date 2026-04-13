import Color from 'color';

type HeatmapToneInput = Readonly<{
    value: number;
    values: readonly number[];
    baseColor: string;
    emptyColor: string;
}>;

function resolvePositiveRank(value: number, positives: readonly number[]): number {
    if (positives.length <= 1) {
        return positives.length === 1 ? 1 : 0;
    }

    let lastIndex = 0;
    for (let index = 0; index < positives.length; index += 1) {
        if (positives[index] <= value) {
            lastIndex = index;
        } else {
            break;
        }
    }

    return lastIndex / (positives.length - 1);
}

export function resolveHeatmapColor(input: HeatmapToneInput): string {
    const { value, values, baseColor, emptyColor } = input;

    if (!Number.isFinite(value) || value <= 0) {
        return emptyColor;
    }

    const positives = values
        .filter((entry) => Number.isFinite(entry) && entry > 0)
        .sort((left, right) => left - right);

    if (positives.length === 0) {
        return emptyColor;
    }

    const percentile = resolvePositiveRank(value, positives);
    const toneIndex = Math.max(0, Math.min(4, Math.round(percentile * 4)));
    const toneMixRatios = [0.78, 0.62, 0.46, 0.24, 0.06] as const;
    const mixRatio = toneMixRatios[toneIndex];

    return Color(baseColor)
        .mix(Color(emptyColor), mixRatio)
        .hex();
}
