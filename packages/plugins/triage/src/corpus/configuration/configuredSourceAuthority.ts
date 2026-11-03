import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';

import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../collections/ids.js';
import type { CorpusSourceInstanceRowV1 } from '../collections/rows.js';

export function sameConfiguredSourceAuthority(previous: CorpusSourceInstanceRowV1, current: CorpusSourceInstanceRowV1 | null): boolean {
    if (current === null || current.lifecycle !== CORPUS_SOURCE_INSTANCE_LIFECYCLE.active
        || current.sourceQualifiedId !== previous.sourceQualifiedId) return false;
    // Locators and configuredAtMs are presentation, not configured source authority.
    const { locator: _previousLocator, ...before } = previous.configured;
    const { locator: _currentLocator, ...after } = current.configured;
    return pluginJsonValuesEqual(before, after);
}
