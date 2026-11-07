/**
 * Who draws a surface's Machine chip. An App page draws its own in its route controls; so does a page companion
 * (opened from its page's own navigation item), which runs in that page's Machine scope rather than choosing a
 * second one. Every other placement draws the chip in its own band.
 */
export function pluginSurfacePageOwnsMachineChip(
    descriptor: Readonly<{
        contributionKind?: string;
        binding?: Readonly<{ kind?: string; container?: string }> | null;
    }> | null | undefined,
    openedFromPage: boolean,
): boolean {
    return descriptor?.contributionKind === 'surfacePlacement'
        && descriptor.binding?.kind === 'destination'
        && (descriptor.binding.container === 'appPage' || openedFromPage);
}
