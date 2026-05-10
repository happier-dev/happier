import * as React from 'react';

import type { DesktopPetOverlaySyncInput } from './useDesktopPetOverlaySync';
import { useDesktopPetOverlaySync } from './useDesktopPetOverlaySync';

export type DesktopPetOverlayRuntimeProps = DesktopPetOverlaySyncInput;

export function DesktopPetOverlayRuntime(props: DesktopPetOverlayRuntimeProps): React.ReactElement | null {
    useDesktopPetOverlaySync(props);
    return null;
}
