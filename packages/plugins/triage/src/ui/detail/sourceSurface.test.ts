import type { PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import { createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';
import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';

import {
    resolveTriageSourceDescriptorV1,
    resolveTriageSourceDetailContributionV1,
    readTriageSourceDescriptorV1,
    readTriageSourceDetailContributionV1,
    readTriageSourceGetOperationV1,
    readTriageSourcePrepareReviewWorkspaceOperationV1,
    readTriageSourcePreparesReviewWorkspaceV1,
    resolveTriageSourceWorkflowSubjectV1,
} from './sourceSurface.js';

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
        occurrenceId: 'generation-1',
        sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' },
    };
    return {
        target: {
            pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
            occurrenceId: 'target-generation-1',
            sourceCustody: { kind: 'development', registeredRootId: 'triage-root' },
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
    it('keeps source rendering and execution unavailable on an Account mount without an admitted occurrence', () => {
        const context = createSurfaceContextFixture({
            target: { kind: 'app' },
        });
        delete context.targetedContributions;

        expect(readTriageSourceDetailContributionV1(context, SOURCE)).toEqual({ kind: 'absent' });
        expect(readTriageSourceDescriptorV1(context, SOURCE)).toBeNull();
        expect(readTriageSourcePreparesReviewWorkspaceV1(context, SOURCE)).toBe(false);
        expect(readTriageSourcePrepareReviewWorkspaceOperationV1(context, SOURCE)).toBeUndefined();
        expect(readTriageSourceGetOperationV1(context, SOURCE)).toBeUndefined();
        expect(resolveTriageSourceWorkflowSubjectV1(context.targetedContributions, testkitEntryRef())).toBeNull();
    });

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

    it('reads descriptor presentation from the same exact mounted snapshot', () => {
        const targeted = snapshot({ descriptor: VALID_DESCRIPTOR });

        expect(resolveTriageSourceDescriptorV1(targeted, SOURCE)).toEqual(VALID_DESCRIPTOR);
        expect(resolveTriageSourceDescriptorV1(
            snapshot({ protocolVersion: PROTOCOL.version + 1, descriptor: VALID_DESCRIPTOR }),
            SOURCE,
        )).toBeNull();
    });
});
