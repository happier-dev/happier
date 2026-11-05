import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';

export type ServerSelectionScope = 'tab' | 'device';

/** Browser tabs and secondary desktop windows own local Home selection. */
export function resolveRoutineServerSelectionScope(
    platformOS: string,
    desktopHost = false,
): ServerSelectionScope {
    if (desktopHost && resolveDesktopWindowContext().role === 'secondary') return 'tab';
    return platformOS === 'web' && !desktopHost ? 'tab' : 'device';
}
