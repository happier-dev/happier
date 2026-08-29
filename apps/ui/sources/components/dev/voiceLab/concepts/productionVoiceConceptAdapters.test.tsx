import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { resolveVoiceAttemptActionability } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import { resolveVoiceAttemptLightStop } from '@/components/voice/attempt/resolveVoiceAttemptLightStop';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { renderScreen } from '@/dev/testkit';

import {
    VOICE_LAB_PROVIDERS,
    VOICE_LAB_STATES,
    VOICE_LAB_STATE_BY_ID,
} from '../voiceLabModel';
import { HorizonConcept } from './HorizonConcept';
import { OrbConcept } from './OrbConcept';
import { createProductionVoiceConceptFixture } from './productionVoiceConceptAdapter';

const baseProps = {
    state: VOICE_LAB_STATE_BY_ID.listening,
    provider: VOICE_LAB_PROVIDERS[0]!,
    surface: 'sidebar' as const,
    expanded: true,
    muted: false,
    onToggleExpanded: vi.fn(),
    onToggleMute: vi.fn(),
    onAction: vi.fn(),
};

function withEnergy(child: React.ReactElement): React.ReactElement {
    return (
        <VoiceEnergyProvider
            state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
            previewTimeMs={1_100}
        >
            {child}
        </VoiceEnergyProvider>
    );
}

describe('selected Voice Lab production adapters', () => {
    it.each(VOICE_LAB_STATES.map((state) => [state.id, state] as const))(
        'consumes the audited production projection and canonical attempt resolver for %s',
        (_id, state) => {
            const fixture = createProductionVoiceConceptFixture({ ...baseProps, state });
            const expectedState = state.modelState ?? 'idle';
            const actionability = resolveVoiceAttemptActionability({
                canStart: fixture.control.canStart,
                canStop: fixture.control.canStop,
                recoveryAvailable: fixture.control.recoveryAvailable,
            });

            expect(fixture.control.surfaceState).toBe(expectedState);
            expect(fixture.horizonModel.attemptControl).toBe(fixture.control);
            expect(fixture.control).toMatchObject(actionability);
            expect(fixture.control.tone).toBe(resolveVoiceSurfaceStatusPresentation(expectedState).tone);
            expect(fixture.control.stop).toBe(resolveVoiceAttemptLightStop(expectedState));
        },
    );

    it.each([
        ['preparing', 'connecting'],
        ['user_speaking', 'listening'],
        ['permission_revoked', 'error'],
        ['degraded', 'idle'],
        ['ended', 'connecting'],
        ['working', 'idle'],
        ['work_rejected', 'idle'],
        ['attention', 'idle'],
    ] as const)('does not promote the ledger state %s into a private semantic state', (id, expected) => {
        const fixture = createProductionVoiceConceptFixture({
            ...baseProps,
            state: VOICE_LAB_STATE_BY_ID[id],
        });
        expect(fixture.control.surfaceState).toBe(expected);
    });

    it('renders the real Horizon seam without adding a live region', async () => {
        const screen = await renderScreen(withEnergy(<HorizonConcept {...baseProps} />));

        expect(screen.findByTestId('voice-surface:sidebar')).toBeTruthy();
        expect(screen.findByTestId('voice-surface-actions:sidebar')).toBeTruthy();
        expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(0);
        await screen.unmount();
    });

    it('renders the real responsive Orb sheet and pinned escape-action bar', async () => {
        const screen = await renderScreen(withEnergy(<OrbConcept {...baseProps} surface="mobile" />));

        expect(screen.findByTestId('voice.orb.body')).toBeTruthy();
        expect(screen.findByTestId('voice.orb.captionScroll')).toBeTruthy();
        expect(screen.findByTestId('voice.orb.bar')).toBeTruthy();
        expect(screen.findByTestId('voice.orb.bar.transport')).toBeTruthy();
        expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(0);
        await screen.unmount();
    });

    it('keeps geometry, actions, and announcement ownership out of both thin adapters', () => {
        for (const [file, canonicalImport] of [
            ['HorizonConcept.tsx', 'VoiceHorizon'],
            ['OrbConcept.tsx', 'VoiceOrb'],
        ] as const) {
            const source = readFileSync(join(
                process.cwd(),
                'sources/components/dev/voiceLab/concepts',
                file,
            ), 'utf8');
            expect(source).toContain(canonicalImport);
            expect(source).not.toContain('accessibilityLiveRegion');
            expect(source).not.toContain('useSharedValue');
            expect(source).not.toContain('Gesture.');
            expect(source).not.toContain('VoiceTransport');
        }
        const projection = readFileSync(join(
            process.cwd(),
            'sources/components/dev/voiceLab/concepts/productionVoiceConceptAdapter.ts',
        ), 'utf8');
        expect(projection).toContain('resolveVoiceAttemptControl({');
        expect(projection).not.toContain('switch (id)');
        expect(projection).not.toContain('projectSurfaceState');
    });
});
