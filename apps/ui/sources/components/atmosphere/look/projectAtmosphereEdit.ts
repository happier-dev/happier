import { applyAtmosphereLayoutDefault, type HomeAtmosphere, type ProjectAtmosphere, type AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import { normalizeProjectAtmosphere } from '../atmosphereSettings';
import { selectAtmosphereSettings } from '../resolveAtmosphere';

export function projectAtmosphereEdit(home: HomeAtmosphere, override: ProjectAtmosphere | 'home' | undefined,
    edit: (value: ProjectAtmosphere) => ProjectAtmosphere,
    shownHomePicture?: AtmospherePresentation['picture']['ref']): ProjectAtmosphere {
    const current = override && override !== 'home'
        ? { ...override, moments: home.moments } : selectAtmosphereSettings('home', home);
    const { moments: _moments, ...value } = (!override || override === 'home') && shownHomePicture && current.source === 'picture'
        ? { ...current, picture: { ...current.picture, ref: shownHomePicture } } : current;
    return normalizeProjectAtmosphere(applyAtmosphereLayoutDefault(value, edit(value)));
}
