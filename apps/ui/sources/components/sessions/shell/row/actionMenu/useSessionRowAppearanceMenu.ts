import * as React from 'react';

import {
    useCustomSessionAppearanceColors,
    useSessionAppearancesSupported,
    useSessionOwnAppearanceColor,
} from '@/hooks/session/useSessionAppearance';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import type { SessionAppearanceColorMenuInput, SessionAppearanceTheme } from '../../appearance/sessionAppearanceColorMenu';

export type SetSessionAppearance = (
    sessionId: string,
    color: SessionAppearanceColor | null,
    opts?: Readonly<{ serverId?: string | null }>,
) => void;

export type SessionRowAppearanceMenu = SessionAppearanceColorMenuInput & Readonly<{
    onChange: (color: SessionAppearanceColor | null) => void;
}>;

/**
 * The session colour menu's data, read only while the row's menu is open: a closed row holds no
 * appearance subscription. Null hides the action — no writer, no server, or a server that cannot
 * store session colours (the project colour stays available on its header).
 */
export function useSessionRowAppearanceMenu(params: Readonly<{
    enabled: boolean;
    serverId: string | null;
    sessionId: string;
    theme: SessionAppearanceTheme;
    /** The row's effective colour; shown as inherited only while the session has none of its own. */
    effectiveColor: SessionAppearanceColor | null;
    onSetSessionAppearance?: SetSessionAppearance | null;
}>): SessionRowAppearanceMenu | null {
    const { theme, effectiveColor, onSetSessionAppearance, serverId, sessionId } = params;
    const enabled = params.enabled && typeof onSetSessionAppearance === 'function' && Boolean(serverId);
    const supported = useSessionAppearancesSupported(serverId, { enabled });
    const active = enabled && supported;
    const current = useSessionOwnAppearanceColor(serverId, sessionId, { enabled: active });
    const customColors = useCustomSessionAppearanceColors(serverId, { enabled: active });
    const onChange = React.useCallback((color: SessionAppearanceColor | null) => {
        onSetSessionAppearance?.(sessionId, color, { serverId });
    }, [onSetSessionAppearance, serverId, sessionId]);
    return React.useMemo(
        () => (active ? { current, inherited: effectiveColor, customColors, theme, onChange } : null),
        [active, current, customColors, effectiveColor, onChange, theme],
    );
}
