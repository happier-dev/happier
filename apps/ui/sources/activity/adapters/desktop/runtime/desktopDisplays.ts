import { invokeDesktopHost, requireDesktopHostRole } from '@/utils/platform/desktopHost';

export type { DesktopDisplaysList } from '@happier-dev/protocol/actions/actionSpecs';
import type { DesktopDisplaysList } from '@happier-dev/protocol/actions/actionSpecs';
export type DesktopDisplay = DesktopDisplaysList['displays'][number];

/** Explicit-demand read shared by the Display menu and desktop.displays.list Action. */
export async function listDesktopDisplays(): Promise<DesktopDisplaysList> {
    await requireDesktopHostRole('activity');
    return invokeDesktopHost<DesktopDisplaysList>('desktop_displays_list');
}
