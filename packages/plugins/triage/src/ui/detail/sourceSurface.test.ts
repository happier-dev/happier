import type { PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { resolveTriageSourceDetailContributionV1 } from './sourceSurface.js';

/**
 * Matching the entry's source to the admitted contribution its detail mounts
 * through.
 *
 * The composed mount case proves the vertical; this proves the decision a
 * composed case cannot reach without an unlikely fixture — a snapshot at a
 * protocol epoch this contract does not speak.
 *
 * The lookup stays a pure identity match. The contributor's descriptor reaches
 * this mount already parsed by the host with this target's own schema, and the
 * one Action that needs it — `entries/read-detail-v1` — carries it typed out of
 * the admitted snapshot, so nothing here decodes a snapshot value.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const PROTOCOL = Object.freeze({
    id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
});

function snapshot(overrides: Readonly<{
    protocolVersion?: number;
    descriptor?: unknown;
}> = {}): PluginUiTargetedContributionsV1 {
    const protocol = { id: PROTOCOL.id, version: overrides.protocolVersion ?? PROTOCOL.version };
    const contributor = {
        pluginId: SOURCE.pluginId,
        contributionId: SOURCE.localId,
        immutableGenerationId: 'generation-1',
    };
    return {
        target: {
            pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
            immutableGenerationId: 'target-generation-1',
        },
        points: [{
            pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
            protocols: [{
                protocol,
                contributions: [{
                    contributor,
                    protocol,
                    ...(overrides.descriptor === undefined
                        ? {}
                        : { descriptor: overrides.descriptor as never }),
                    operations: [],
                    surfaces: [{
                        point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol },
                        contributor,
                        role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
                        presentation: 'content',
                    }],
                }],
            }],
        }],
    };
}

const VALID_DESCRIPTOR = Object.freeze({
    v: 1,
    purpose: 'triage-source',
    displayName: 'Example forge',
    kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
});

describe('the source detail contribution lookup', () => {
    it('refuses a contribution at a protocol epoch this contract does not speak', () => {
        expect(resolveTriageSourceDetailContributionV1(
            snapshot({ protocolVersion: PROTOCOL.version + 1 }),
            SOURCE,
        )).toEqual({ kind: 'absent' });
    });

    it('returns the exact admitted surface of the entry\'s own source', () => {
        const lookup = resolveTriageSourceDetailContributionV1(
            snapshot({ descriptor: VALID_DESCRIPTOR }),
            SOURCE,
        );

        expect(lookup.kind).toBe('admitted');
        if (lookup.kind !== 'admitted') return;
        expect(lookup.surface.role).toBe(TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1);
        expect(lookup.surface.contributor.pluginId).toBe(SOURCE.pluginId);
        expect(lookup.surface.contributor.contributionId).toBe(SOURCE.localId);
    });
});
