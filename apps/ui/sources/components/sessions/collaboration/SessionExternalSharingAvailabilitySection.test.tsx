import * as React from 'react';
import { t } from '@/text';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalSessionSharingAvailability } from '@/components/sessions/external/sharing/useExternalSessionSharingAvailability';
import { renderScreen } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { SessionExternalSharingAvailabilitySection } from './SessionExternalSharingAvailabilitySection';
import type { ExactSessionSnapshotState } from './useExactSessionSnapshot';

const readySnapshot: ExactSessionSnapshotState = {
    key: 'home\u0000account\u0000session',
    kind: 'ready',
    session: { id: 'session' } as Session,
    retry: vi.fn(),
};

function availability(overrides: Partial<ExternalSessionSharingAvailability>): ExternalSessionSharingAvailability {
    return {
        sharingPresentation: {
            shareable: false,
            state: 'requires_persisted_import',
            machineName: 'Studio',
            action: 'import_awaiting_action_owner',
            materializedThroughSourceAt: null,
        },
        sharingPresentationNowMs: 1_000,
        canStartMaterialization: true,
        sourceMachineUnavailableReason: null,
        updateSharedCopySubtitle: 'Refresh the shared snapshot.',
        materializeInFlight: false,
        startMaterialization: vi.fn(),
        canResumePartialImport: false,
        resumeInFlight: false,
        resumePartialImport: vi.fn(),
        ...overrides,
    } as ExternalSessionSharingAvailability;
}

describe('SessionExternalSharingAvailabilitySection', () => {
    it('restores the canonical materialize action before Access and publication', async () => {
        const startMaterialization = vi.fn();
        const screen = await renderScreen(
            <SessionExternalSharingAvailabilitySection
                snapshot={readySnapshot}
                availability={availability({ startMaterialization })}
            />,
        );

        expect(screen.findByTestId('session-external-sharing-materialize')).not.toBeNull();
        await screen.pressByTestIdAsync('session-external-sharing-materialize');
        expect(startMaterialization).toHaveBeenCalledTimes(1);
    });

    it('restores resume and stale-update through the same availability owner', async () => {
        const resumePartialImport = vi.fn();
        const resumeScreen = await renderScreen(
            <SessionExternalSharingAvailabilitySection
                snapshot={readySnapshot}
                availability={availability({
                    sharingPresentation: {
                        shareable: false,
                        state: 'import_incomplete',
                        machineName: 'Studio',
                        action: 'resume_awaiting_action_owner',
                        materializedThroughSourceAt: null,
                    },
                    canResumePartialImport: true,
                    resumePartialImport,
                })}
            />,
        );
        await resumeScreen.pressByTestIdAsync('session-external-sharing-resume');
        expect(resumePartialImport).toHaveBeenCalledTimes(1);

        const startMaterialization = vi.fn();
        const updateScreen = await renderScreen(
            <SessionExternalSharingAvailabilitySection
                snapshot={readySnapshot}
                availability={availability({
                    sharingPresentation: {
                        shareable: true,
                        state: 'shared_snapshot_stale',
                        machineName: 'Studio',
                        action: 'update_awaiting_action_owner',
                        materializedThroughSourceAt: 900,
                    },
                    startMaterialization,
                })}
            />,
        );
        await updateScreen.pressByTestIdAsync('session-external-sharing-update');
        expect(startMaterialization).toHaveBeenCalledTimes(1);
    });

    it('keeps exact-snapshot failure visible and retryable', async () => {
        const retry = vi.fn();
        const screen = await renderScreen(
            <SessionExternalSharingAvailabilitySection
                snapshot={{ key: 'scope', kind: 'unavailable', session: null, retry }}
                availability={null}
            />,
        );

        expect(screen.findHostByTestId('session-external-sharing-failed')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('errors.operationFailed'));
        await screen.pressByTestIdAsync('session-external-sharing-retry');
        expect(retry).toHaveBeenCalledTimes(1);
    });
});
