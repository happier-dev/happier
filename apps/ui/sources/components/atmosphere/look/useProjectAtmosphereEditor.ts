import * as React from 'react';
import { useProjectAtmosphere, useSetting } from '@/sync/store/hooks';
import { storage } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import type { ProjectAtmosphere, AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AtmosphereEditor } from './atmosphereEditor';
import { projectAtmosphereEdit } from './projectAtmosphereEdit';
import { readProjectAtmospherePreview, readSettingWithPreview, useProjectAtmospherePreview } from '@/sync/store/settingsPreview';
import { readProjectAtmosphere } from '@/sync/store/domains/projectAccountRows';
import { useAtmosphere } from '../useAtmosphere';

/** Persisted Look edits enter Settings Actions; the Project row owner retains fresh intent and CAS. */
export function useProjectAtmosphereEditor(project: Readonly<{ serverId: string; projectKey: string }>): AtmosphereEditor {
    const home = useSetting('homeAtmosphere');
    const override = useProjectAtmosphere(project);
    const storedOverride = storage(state => readProjectAtmosphere(state, project));
    const setPreview = useProjectAtmospherePreview(project);
    const atmosphere = useAtmosphere({ project });
    const { setSetting, isCurrent } = useSettingActionFeedback({ serverId: project.serverId });
    const shownHomePicture = atmosphere.source === 'picture' ? atmosphere.picture.ref : undefined;
    const write = React.useCallback((edit: ((value: ProjectAtmosphere) => ProjectAtmosphere) | 'home') => {
        const setting = { anchor: 'appearance.projectAtmosphere', target: { kind: 'project' as const, ...project } };
        if (!isCurrent(setting)) return;
        const state = storage.getState();
        const value = edit === 'home' ? 'home' : projectAtmosphereEdit(readSettingWithPreview('homeAtmosphere'),
            readProjectAtmospherePreview(project) ?? readProjectAtmosphere(state, project), edit, shownHomePicture);
        return setSetting(setting, value, { executorOptions: { projectAtmosphereEdit: { target: project, edit, shownHomePicture } } });
    }, [project.projectKey, project.serverId, shownHomePicture, isCurrent, setSetting]);
    return React.useMemo<AtmosphereEditor>(() => ({
        value: override && override !== 'home' ? override : home,
        showOn: override && override !== 'home' ? override.showOn : home.showOn,
        setShowOn: places => write(current => ({ ...current, showOn: [...places] })),
        shownPictureRef: shownHomePicture,
        preview: edit => {
            const state = storage.getState();
            setPreview(edit ? projectAtmosphereEdit(readSettingWithPreview('homeAtmosphere'),
                readProjectAtmospherePreview(project) ?? readProjectAtmosphere(state, project),
                current => ({ ...current, ...edit(current) }), shownHomePicture) : undefined);
        },
        pictureActions: { target: { kind: 'project', serverId: project.serverId, projectKey: project.projectKey } },
        update: (edit: (value: AtmospherePresentation) => AtmospherePresentation) => write(current => ({ ...current, ...edit(current) })),
        sameAsHome: storedOverride === undefined || storedOverride === 'home',
        resetToHome: () => write('home'),
    }), [home, override, storedOverride, project.projectKey, project.serverId, write, setPreview, shownHomePicture]);
}
