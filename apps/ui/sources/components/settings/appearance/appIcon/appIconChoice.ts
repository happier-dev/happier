import type { AppIconActionRefusal, AppIconListResult } from '@happier-dev/protocol';

import { resolveAppIconHost, type AppIconHost } from './appIconHost';
import { findAppIcon, resolveAppIconAvailability, type AppIconEntitlement } from './appIcons';

/**
 * List and set, shared by Appearance › App icon and the `app.icon.list` / `app.icon.set` Actions,
 * so a refusal means the same thing on every surface. No server call: the icon belongs to the device.
 */
export async function listAppIcons(
    entitlement: AppIconEntitlement,
    host: AppIconHost | null = resolveAppIconHost(),
): Promise<AppIconListResult> {
    return {
        supported: host !== null,
        currentIconId: host ? await host.readCurrentIconId() : null,
        icons: resolveAppIconAvailability(entitlement).map(({ icon, locked }) => ({ id: icon.id, access: icon.access, locked })),
    };
}

export async function setAppIcon(
    iconId: string,
    entitlement: AppIconEntitlement,
    host: AppIconHost | null = resolveAppIconHost(),
): Promise<Readonly<{ iconId: string }> | AppIconActionRefusal> {
    const icon = findAppIcon(iconId);
    if (!icon) return { ok: false, errorCode: 'invalid_parameters' };
    if (!host) return { ok: false, errorCode: 'host_unsupported' };
    const available = resolveAppIconAvailability(entitlement).find((entry) => entry.icon.id === icon.id);
    if (!available || available.locked) return { ok: false, errorCode: 'supporter_required' };
    await host.apply(icon);
    return { iconId: icon.id };
}
