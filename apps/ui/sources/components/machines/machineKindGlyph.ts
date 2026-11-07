/**
 * The one glyph for a machine's kind wherever a machine stands without its own provider mark (lab m-pick,
 * m-detail rail): a laptop for this computer, a server for a Linux box (the dev boxes, VPSs and build
 * machines people reach over the network), and the desktop for every other or not-yet-known machine.
 */
export function resolveMachineKindGlyph(input: Readonly<{ isThisComputer: boolean; platform?: string | null }>): 'laptop' | 'hard-drives' | 'desktop' {
    if (input.isThisComputer) return 'laptop';
    return input.platform === 'linux' ? 'hard-drives' : 'desktop';
}
