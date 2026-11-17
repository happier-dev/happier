import type { PluginUiInlineSurfaceRoleV1 } from '@happier-dev/protocol/plugins/ui';

/**
 * Who draws a surface's Machine chip. An App page draws its own in its route controls; so does a page companion
 * (opened from its page's own navigation item), which runs in that page's Machine scope rather than choosing a
 * second one. An inline placement (an Agent's settings, a Session pane or info section) runs in its host's
 * Machine scope too, so the host owns the chip; a widget is a glance on its own and keeps its chip. Every other
 * placement draws the chip in its own band.
 */
export function pluginSurfacePageOwnsMachineChip(
    descriptor: Readonly<{
        contributionKind?: string;
        binding?: Readonly<{ kind?: string; container?: string }> | null;
    }> | null | undefined,
    openedFromPage: boolean,
    inlineRole?: PluginUiInlineSurfaceRoleV1,
): boolean {
    if (descriptor?.contributionKind !== 'surfacePlacement') return false;
    if (descriptor.binding?.kind === 'inline') return inlineRole !== undefined && inlineRole !== 'widget';
    return descriptor.binding?.kind === 'destination'
        && (descriptor.binding.container === 'appPage' || openedFromPage);
}
