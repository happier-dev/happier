let demoModeDepth = 0;

export function isDemoModeActive(): boolean {
    return demoModeDepth > 0;
}

export function enterDemoMode(): void {
    demoModeDepth += 1;
}

export function exitDemoMode(): void {
    demoModeDepth = Math.max(0, demoModeDepth - 1);
}

export function resetDemoModeDepthForTests(): void {
    demoModeDepth = 0;
}
