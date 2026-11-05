import { applyAtmosphereLayoutDefault, type HomeAtmosphere, type ProjectAtmosphere } from '@happier-dev/protocol/account/settings/accountSettings';
import { normalizeProjectAtmosphere } from '../atmosphereSettings';

export function projectAtmosphereEdit(home: HomeAtmosphere, override: ProjectAtmosphere | 'home' | undefined,
    edit: (value: ProjectAtmosphere) => ProjectAtmosphere): ProjectAtmosphere {
    const { moments: _moments, ...value } = override && override !== 'home' ? { ...override, moments: home.moments } : home;
    return normalizeProjectAtmosphere(applyAtmosphereLayoutDefault(value, edit(value)));
}
