export function resolveMinimumInteractiveTargetSize(platform: string): 44 | 48 {
    return platform === 'android' ? 48 : 44;
}
