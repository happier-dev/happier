import type { MeshGradientPatternVariant } from './meshGradientTypes';

const PATTERN_VARIANTS: readonly MeshGradientPatternVariant[] = [
    'organic',
    'columns',
    'rows',
    'diagonal',
    'oval',
    'waves',
    'softNoise',
    'organic',
];

export function pickMeshGradientPatternVariant(seed: number): MeshGradientPatternVariant {
    return PATTERN_VARIANTS[seed % PATTERN_VARIANTS.length] ?? 'organic';
}
