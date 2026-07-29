import {
    clearSessionStateFieldFromMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';

/**
 * Owner Session metadata is lossless host state. Agent/plugin leaves receive
 * the same launch and correlation fields, but never the complete private
 * External Session operation record.
 */
export function projectAgentVisibleSessionMetadata(
    metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
    return Object.freeze(clearSessionStateFieldFromMetadata(
        metadata,
        'runtime.externalSessionOperation',
    ));
}
