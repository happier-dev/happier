import { definePlugin } from '@happier-dev/plugin-sdk';

import { publicAuthoringDefinition } from './definition.js';

export const { manifest, activate, collectionMigrations } = definePlugin(publicAuthoringDefinition);

// The author build emits this entry as `dist/daemon.js`; retain the locator
// consumed by the separately emitted definition module as a named ESM export.
export { reviewAgentRunnerFactory } from './daemon.js';

export {
    createReviewAgentRuntime,
    observeSessionSpawned,
    reviewReferenceProvider,
    reviewSessionStatusResource,
    resolveAgentContextCompanionComposition,
    runExternalSessionDigest,
    runReviewSummary,
} from './definition.js';
