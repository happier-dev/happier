export type MeshGradientThemeInput = Readonly<{
    surface: string;
    surfaceHigh: string;
    surfaceHighest: string;
    textSecondary: string;
    accentColors: readonly string[];
}>;

export type MeshGradientColorField = Readonly<{
    cx: number;
    cy: number;
    radius: number;
    color: string;
    transparentColor: string;
    opacity: number;
}>;

export type MeshGradientWaveField = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    color: string;
    transparentColor: string;
    opacity: number;
}>;

export type MeshGradientDepthField = Readonly<{
    cx: number;
    cy: number;
    radius: number;
    color: string;
    transparentColor: string;
}>;

export type MeshGradientPatternVariant = 'organic' | 'columns' | 'rows' | 'diagonal' | 'oval' | 'waves' | 'softNoise';

export type MeshGradientAvatarModel = Readonly<{
    patternVariant: MeshGradientPatternVariant;
    baseGradient: Readonly<{
        startX: number;
        startY: number;
        endX: number;
        endY: number;
        startColor: string;
        endColor: string;
    }>;
    depthField: MeshGradientDepthField;
    highlightField: MeshGradientDepthField;
    colorFields: readonly MeshGradientColorField[];
    waveFields: readonly MeshGradientWaveField[];
}>;
