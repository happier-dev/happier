import type { ParsedPluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { checkTriageSourceContributionV1 } from './conformance.js';

/**
 * Asserts that one source manifest declares a complete Triage sources V1
 * contribution before it reaches host admission.
 */
export function assertTriageSourceContributionV1(manifest: unknown): ParsedPluginManifest {
    const result = checkTriageSourceContributionV1(manifest);
    if (!result.ok) {
        throw new TypeError(
            `Triage sources V1 contribution is not conformant: ${result.errors.join(' ')}`,
        );
    }
    return result.manifest;
}
