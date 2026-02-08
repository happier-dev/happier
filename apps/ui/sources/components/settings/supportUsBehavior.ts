export function resolveSupportUsAction(input: { isPro: boolean }): 'github' | 'paywall' {
    return input.isPro ? 'github' : 'paywall';
}
