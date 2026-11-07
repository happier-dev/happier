let demoModeDepth = 0;
let demoServerId: string | null = null;

export function isDemoModeActive(): boolean {
    return demoModeDepth > 0;
}

/** Exact Home whose complete local corpus was installed by the demo seeder. */
export function getDemoModeServerId(): string | null {
    return isDemoModeActive() ? demoServerId : null;
}

/** Local demo corpus availability is presentation data, never credential admission. */
export function isSeededDemoHome(serverId: string): boolean {
    const seededServerId = getDemoModeServerId();
    return seededServerId !== null && serverId.trim() === seededServerId;
}

export function enterDemoMode(serverId?: string): void {
    demoModeDepth += 1;
    if (serverId) demoServerId = serverId;
}

export function exitDemoMode(): void {
    demoModeDepth = Math.max(0, demoModeDepth - 1);
    if (demoModeDepth === 0) demoServerId = null;
}

export function resetDemoModeDepthForTests(): void {
    demoModeDepth = 0;
    demoServerId = null;
}
