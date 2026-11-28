import catalog from './appIcons.json';

/**
 * The eight app icons (plan 04, App icons). `appIcons.json` is the one list: `app.config.js` reads it
 * to register the native alternates (`plugins/withAppIcons.js`), the desktop shell embeds the same
 * ids, and the picker and the `app.icon.*` Actions read it through this module.
 *
 * Ids and native names ship inside binaries and a person's chosen icon references them, so they are
 * never renamed; a rename needs a migration step.
 */

export type AppIconAccess = 'everyone' | 'supporter';

export type AppIconDefinition = Readonly<{
    id: string;
    /** iOS alternate icon name and Android `MainActivity<Name>` alias; null for the bundle icon. */
    nativeName: string | null;
    access: AppIconAccess;
}>;

export const DEFAULT_APP_ICON_ID = 'default';

export const APP_ICONS: readonly AppIconDefinition[] = Object.freeze(catalog.icons.map((icon) => Object.freeze({
    id: icon.id,
    nativeName: icon.nativeName,
    access: icon.access === 'supporter' ? 'supporter' : 'everyone',
} satisfies AppIconDefinition)));

export function findAppIcon(id: string): AppIconDefinition | null {
    return APP_ICONS.find((icon) => icon.id === id) ?? null;
}

/** The catalog id for what the OS reports; an unknown name (a newer binary's icon) reads as unknown. */
export function findAppIconByNativeName(nativeName: string | null): AppIconDefinition | null {
    return APP_ICONS.find((icon) => icon.nativeName === nativeName) ?? null;
}

export type AppIconAvailability = Readonly<{ icon: AppIconDefinition; locked: boolean }>;

export type AppIconEntitlement = Readonly<{
    /** `supporter.active` from the account plan read; false when unknown. */
    supporterActive: boolean;
    /** The Supporter offer exists on this server (`plans` or `supporter` bit). Off: the six are not shown. */
    supporterIconsOffered: boolean;
}>;

/**
 * The one decider for which icons a person sees and which are theirs (plan 04 mechanism ledger).
 * Client-side and honest-system by ruling: the perk is cosmetic and decided at pick time.
 */
export function resolveAppIconAvailability(entitlement: AppIconEntitlement): readonly AppIconAvailability[] {
    return APP_ICONS
        .filter((icon) => icon.access === 'everyone' || entitlement.supporterIconsOffered)
        .map((icon) => ({ icon, locked: icon.access === 'supporter' && !entitlement.supporterActive }));
}
