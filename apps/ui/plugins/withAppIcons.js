const withAlternateAppIcons = require('expo-alternate-app-icons/app.plugin').default;

const catalog = require('../sources/components/settings/appearance/appIcon/appIcons.json');

const ASSET_ROOT = './sources/assets/images/app-icons';
// Themed (monochrome) launcher icons keep the shared mark silhouette, which every alternate keeps.
const MONOCHROME = './sources/assets/images/icon-adaptive.png';

/** The native alternates, from the one icon list the picker also reads (`appIcons.json`). */
function resolveAlternateIcons() {
    return catalog.icons
        .filter((icon) => icon.nativeName !== null)
        .map((icon) => ({
            name: icon.nativeName,
            ios: `${ASSET_ROOT}/${icon.id}/ios.png`,
            android: {
                foregroundImage: `${ASSET_ROOT}/${icon.id}/android-foreground.png`,
                backgroundColor: icon.androidBackgroundColor,
                monochromeImage: MONOCHROME,
            },
        }));
}

/**
 * Registers the eight app icons (plan 04 U6) through `expo-alternate-app-icons`.
 *
 * Android: the package moves MAIN/LAUNCHER from `MainActivity` to one `activity-alias` per icon and
 * copies `android.intentFilters` onto every alias. `MainActivity` keeps its own copy of those
 * filters (and the app scheme), and it is never disabled, so a copy on the enabled alias would make
 * a second handler for the same https App Link inside this app and ask the person which one to open.
 * The package reads the filters when the plugin is applied, so it is given a view of the config
 * without them; the deep links stay where they are, on `MainActivity`.
 */
function withAppIcons(config) {
    const alternateIcons = resolveAlternateIcons();
    const intentFilters = config.android?.intentFilters;
    const withoutAliasFilters = { ...config, android: { ...config.android, intentFilters: [] } };
    const next = withAlternateAppIcons(withoutAliasFilters, alternateIcons);
    return { ...next, android: { ...next.android, intentFilters } };
}

module.exports = withAppIcons;
module.exports.resolveAlternateIcons = resolveAlternateIcons;
