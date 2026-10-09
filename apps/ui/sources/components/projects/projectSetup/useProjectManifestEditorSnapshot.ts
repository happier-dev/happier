import { useSyncExternalStore } from 'react';

import type { ProjectManifestEditorModel } from './projectManifestEditorModel';

/** Subscribe inside the active editor leaf so typing does not update the Project shell. */
export function useProjectManifestEditorSnapshot(model: ProjectManifestEditorModel) {
    return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
}
