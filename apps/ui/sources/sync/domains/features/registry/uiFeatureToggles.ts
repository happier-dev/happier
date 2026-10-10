import type { FeatureId } from '@happier-dev/protocol';

import {
    getUiFeatureDefinition,
    type UiFeatureToggleServerVisibilityScope,
} from './uiFeatureRegistry';

export { listUiFeatureToggleDefinitions, resolveUiFeatureToggleEnabled, buildUiFeatureToggleDefaults, buildUiFeatureToggleChange, buildUiFeatureExperimentsChange } from '@happier-dev/protocol/actions/settings/featurePreferenceMutations';
export type { UiFeatureToggleDefinition } from '@happier-dev/protocol/actions/settings/featurePreferenceMutations';

export function resolveUiFeatureToggleServerVisibilityScope(featureId: FeatureId): UiFeatureToggleServerVisibilityScope {
    return getUiFeatureDefinition(featureId).settingsToggle?.serverVisibilityScope ?? 'main_selection';
}
