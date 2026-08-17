export type HappierTextScaleOwnership = Readonly<{
  metricScale: number;
  allowHostFontScaling: boolean;
}>;

function normalizeScale(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Select exactly one owner for the OS accessibility scale.
 *
 * A mounted plugin environment already projects the host's resolved font scale,
 * so shared metrics apply that value and native Text/TextInput must not apply it
 * again. An explicit scale is Happier core's separate in-app multiplier; native
 * Dynamic Type remains additive in that path, as the app setting promises.
 */
export function resolveHappierTextScaleOwnership(input: Readonly<{
  explicitTextScale?: number;
  environmentTextScale?: number;
}>): HappierTextScaleOwnership {
  const environmentOwnsScale = input.explicitTextScale === undefined
    && input.environmentTextScale !== undefined;
  return Object.freeze({
    metricScale: normalizeScale(input.explicitTextScale ?? input.environmentTextScale),
    allowHostFontScaling: !environmentOwnsScale,
  });
}
