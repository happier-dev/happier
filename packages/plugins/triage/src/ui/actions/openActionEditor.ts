import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { isHostCancellation } from '../../hostCancellation.js';
import { buildTriageActionEditorLaunchInputV1, TRIAGE_APP_PAGE_DESTINATION_V1 } from '@happier-dev/triage-protocol/v1';

/**
 * Edit action… / Configure actions from any Triage surface: open the Triage page with the editor launch, exactly as a
 * core page does. `subPath` keeps a caller already on the page at its own location. A refused open changes nothing.
 */
export async function openTriageActionEditorV1(
    hostApi: Pick<PluginUiHostApi, 'openSurface'>,
    request: Readonly<{ actionId?: string; subPath?: string }>,
): Promise<void> {
    await hostApi.openSurface(TRIAGE_APP_PAGE_DESTINATION_V1, buildTriageActionEditorLaunchInputV1(request.actionId),
        { subPath: request.subPath ?? '' }).catch(error => { if (!isHostCancellation(error, undefined)) throw error; });
}
