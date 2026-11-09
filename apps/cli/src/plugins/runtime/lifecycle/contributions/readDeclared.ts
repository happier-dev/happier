import type {
    PluginSystemToolContributionV1,
} from '@happier-dev/protocol';

import { isRecord } from '../utils';

/**
 * Readers that pull the runtime metadata consumed by the activated registry
 * off a raw (already schema validated) plugin manifest `contributes` value.
 */

export function readDeclaredSystemToolContributions(value: unknown): readonly PluginSystemToolContributionV1[] {
    if (!isRecord(value) || !Array.isArray(value.systemTools)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.systemTools as PluginSystemToolContributionV1[]);
}
