import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

import type { LocalServicePublicPolicyV1, LocalServicePublicPreviewSnapshotV1 } from '@happier-dev/protocol';

import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
    type LocalServicePublicPreviewState,
} from './store';
import {
    resolveLocalServicePreviewUnavailableSubtitle,
    resolveLocalServicePublicPreviewCreateDisabledSubtitle,
} from './presentation';

const READY_POLICY: LocalServicePublicPolicyV1 = {
    enabled: true,
    allowedModes: ['secret_link'],
    maxTtlMs: 600_000,
    maxConcurrentExposures: 1,
    dnsTlsRequired: true,
    auditRequired: true,
    rateLimitProfileIds: ['default'],
};

function buildState(policy: LocalServicePublicPolicyV1): LocalServicePublicPreviewState {
    const snapshot: LocalServicePublicPreviewSnapshotV1 = {
        v: 1,
        machineId: 'machine_1',
        sessionId: 'session_1',
        previewId: 'preview_1',
        generatedAt: 2_000,
        refreshState: 'idle',
        policy,
        exposures: [],
        diagnostics: [],
    };
    return applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), snapshot);
}

describe('public preview disabled subtitle — server capability reasons (P1-3)', () => {
    it('names the exact unmet prerequisite instead of the generic policy sentence', () => {
        const subtitle = resolveLocalServicePublicPreviewCreateDisabledSubtitle({
            state: buildState({ ...READY_POLICY, enabled: false }),
            activeExposureCount: 0,
            previewId: 'preview_1',
            capabilityDisabledReasons: ['pms_allowed_ports_empty'],
        });

        expect(subtitle).toBe('localServices.publicPreview.disabledReason.tunnelPortsUnconfigured');
    });

    it('distinguishes one mis-set prerequisite from another', () => {
        const relayOff = resolveLocalServicePublicPreviewCreateDisabledSubtitle({
            state: buildState({ ...READY_POLICY, enabled: false }),
            activeExposureCount: 0,
            previewId: 'preview_1',
            capabilityDisabledReasons: ['pms_server_relay_disabled'],
        });
        const ttlMissing = resolveLocalServicePublicPreviewCreateDisabledSubtitle({
            state: buildState({ ...READY_POLICY, enabled: false }),
            activeExposureCount: 0,
            previewId: 'preview_1',
            capabilityDisabledReasons: ['max_ttl_unconfigured'],
        });

        expect(relayOff).toBe('localServices.publicPreview.disabledReason.tunnelRelayDisabled');
        expect(ttlMissing).toBe('localServices.publicPreview.disabledReason.linkLifetimeUnconfigured');
        expect(relayOff).not.toBe(ttlMissing);
    });

    it('reports every unmet prerequisite, not only the first', () => {
        const subtitle = resolveLocalServicePublicPreviewCreateDisabledSubtitle({
            state: buildState({ ...READY_POLICY, enabled: false }),
            activeExposureCount: 0,
            previewId: 'preview_1',
            capabilityDisabledReasons: [
                'pms_server_relay_disabled',
                'mode_unconfigured',
                'max_ttl_unconfigured',
                'rate_limit_profile_unconfigured',
            ],
        });

        expect(subtitle).toBe([
            'localServices.publicPreview.disabledReason.tunnelRelayDisabled',
            'localServices.publicPreview.disabledReason.modeUnconfigured',
            'localServices.publicPreview.disabledReason.linkLifetimeUnconfigured',
            'localServices.publicPreview.disabledReason.rateLimitProfileUnconfigured',
        ].join(' '));
    });

    it('covers every reason code the server can emit', () => {
        // Mirrors the `publicDisabledReasons` fold in `resolveLocalServicesFeature`
        // (apps/server/sources/app/features/localServicesFeature.ts) — the only producer.
        // Keep this list in step with it: an unmapped code silently degrades to the generic
        // sentence, which is exactly the defect this vocabulary exists to remove.
        const serverCodes = [
            'disabled_by_server_policy',
            'pms_server_relay_disabled',
            'pms_allowed_ports_empty',
            'peer_mediation_grant_signing_unavailable',
            'mode_unconfigured',
            'max_ttl_unconfigured',
            'dns_tls_unavailable',
            'audit_sink_unavailable',
            'rate_limit_profile_unconfigured',
            'rate_limit_checker_unavailable',
        ] as const;

        for (const code of serverCodes) {
            const subtitle = resolveLocalServicePublicPreviewCreateDisabledSubtitle({
                state: buildState({ ...READY_POLICY, enabled: false }),
                activeExposureCount: 0,
                previewId: 'preview_1',
                capabilityDisabledReasons: [code],
            });
            expect(subtitle, `unmapped public preview reason code: ${code}`)
                .not.toBe('localServices.publicPreview.disabledPolicySubtitle');
            expect(subtitle, `unmapped public preview reason code: ${code}`).toBeTruthy();
        }
    });

    it('falls back to the generic sentence when the server sends a code this client does not know', () => {
        const subtitle = resolveLocalServicePublicPreviewCreateDisabledSubtitle({
            state: buildState({ ...READY_POLICY, enabled: false }),
            activeExposureCount: 0,
            previewId: 'preview_1',
            capabilityDisabledReasons: ['a_code_from_a_newer_server'],
        });

        expect(subtitle).toBe('localServices.publicPreview.disabledPolicySubtitle');
    });

    it('keeps a live runtime diagnostic ahead of a static capability reason', () => {
        const state = applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
            v: 1,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            generatedAt: 2_000,
            refreshState: 'error',
            policy: { ...READY_POLICY, enabled: false },
            exposures: [],
            diagnostics: [{
                v: 1,
                code: 'public_policy_denied',
                severity: 'error',
                scope: 'publicPreview',
                previewId: 'preview_1',
                emittedAtMs: 2_000,
                details: { reasonCode: 'too_many_public_exposures' },
            }],
        });

        const subtitle = resolveLocalServicePublicPreviewCreateDisabledSubtitle({
            state,
            activeExposureCount: 0,
            previewId: 'preview_1',
            capabilityDisabledReasons: ['mode_unconfigured'],
        });

        expect(subtitle).toBe('localServices.publicPreview.disabledLimitSubtitle');
    });

    it('leaves a ready policy enabled', () => {
        const subtitle = resolveLocalServicePublicPreviewCreateDisabledSubtitle({
            state: buildState(READY_POLICY),
            activeExposureCount: 0,
            previewId: 'preview_1',
            capabilityDisabledReasons: [],
        });

        expect(subtitle).toBeNull();
    });
});

describe('preview unavailable subtitle — server capability reasons (P1-3)', () => {
    it('explains why no local preview exists rather than telling the user to open one', () => {
        expect(resolveLocalServicePreviewUnavailableSubtitle({
            capabilityDisabledReasons: ['pms_allowed_ports_empty'],
        })).toBe('localServices.publicPreview.disabledReason.tunnelPortsUnconfigured');

        expect(resolveLocalServicePreviewUnavailableSubtitle({
            capabilityDisabledReasons: ['disabled_by_server_policy'],
        })).toBe('localServices.publicPreview.disabledReason.previewServerDisabled');
    });

    it('falls back to the open-a-preview prompt when the server reports no blocker', () => {
        expect(resolveLocalServicePreviewUnavailableSubtitle({
            capabilityDisabledReasons: [],
        })).toBe('localServices.publicPreview.disabledNoPreviewSubtitle');
    });
});
