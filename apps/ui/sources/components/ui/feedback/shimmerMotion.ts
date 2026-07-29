export function resolveShimmerAnimationEnabled(input: Readonly<{
    reducedMotion: boolean;
    animationEnabled?: boolean;
}>): boolean {
    return input.animationEnabled !== false && !input.reducedMotion;
}
