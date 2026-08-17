import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveVoiceEnergyRuntimeActivation } from './resolveVoiceEnergyRuntimeActivation';

const SOURCES_ROOT = join(process.cwd(), 'sources');

function readSource(relativePath: string): string {
    return readFileSync(join(SOURCES_ROOT, relativePath), 'utf8');
}

/**
 * The energy bus is only a bus if the app actually mounts it.
 *
 * The provider was built, tested and then mounted nowhere but the design lab —
 * every production surface kept its own frame callback and the shared clock ran
 * for no one. "One provider, mounted once" (§4.2 rule 6) has no runtime
 * observable to assert, so the mount itself is pinned as source structure, the
 * way `voiceSurfaceArchitecture.test.ts` pins the surface seam.
 */
describe('Voice energy app mount', () => {
    it('wraps the whole app tree — the ROOT layout, not the nested route layout', () => {
        /*
         * This assertion previously pinned `app/(app)/_layout.tsx`, and that is the
         * placement that crashed the app on desktop web: `SidebarNavigator` is
         * mounted in the ROOT layout and its drawer renders
         * `<VoiceSurface variant="sidebar" />`, which sits strictly ABOVE the
         * nested route layout. The sidebar surface therefore never saw the
         * provider and `useVoiceEnergy` threw. The phone mount lives inside the
         * route layout, so the compact layout worked and hid the break.
         *
         * `AuthenticatedAppRuntimeMounts` is still the wrong site for a different
         * reason — it renders null-returning siblings, not a wrapper.
         */
        const layout = readSource('app/_layout.tsx');
        expect(layout).toContain('VoiceEnergyAppProvider');
        expect(/<VoiceEnergyAppProvider>[\s\S]*<\/VoiceEnergyAppProvider>/.test(layout)).toBe(true);
        expect(readSource('app/(app)/_layout.tsx')).not.toContain('VoiceEnergyAppProvider');
    });

    it('keeps exactly one production mount of the provider', () => {
        // A second mount is a second clock and a second presence count, which is
        // the cost the whole design exists to avoid.
        const mount = readSource('components/voice/light/VoiceEnergyAppProvider.tsx');
        expect(mount.match(/<VoiceEnergyProvider/g)).toHaveLength(1);
    });
});

describe('resolveVoiceEnergyRuntimeActivation', () => {
    const PROVIDER = 'happier.voice.openai/realtime-openai';

    it('reports no provider while Voice is off', () => {
        expect(resolveVoiceEnergyRuntimeActivation({
            providerId: null,
            status: 'connected',
            inputSourceActive: true,
        })).toEqual({ providerReady: false, attemptActive: true, micCaptureActive: true });
    });

    it('treats connecting and connected as the live attempt', () => {
        expect(resolveVoiceEnergyRuntimeActivation({
            providerId: PROVIDER,
            status: 'connecting',
            inputSourceActive: false,
        })).toEqual({ providerReady: true, attemptActive: true, micCaptureActive: false });
        expect(resolveVoiceEnergyRuntimeActivation({
            providerId: PROVIDER,
            status: 'connected',
            inputSourceActive: true,
        })).toEqual({ providerReady: true, attemptActive: true, micCaptureActive: true });
    });

    it('separates the live attempt from the live microphone', () => {
        // §2.4a — the whole point. `connected` covers `acquiring_mic`, where the
        // attempt exists and the capture source does not. Reporting capture here
        // is what made the planet breathe at a microphone that was not open yet.
        expect(resolveVoiceEnergyRuntimeActivation({
            providerId: PROVIDER,
            status: 'connected',
            inputSourceActive: false,
        })).toEqual({ providerReady: true, attemptActive: true, micCaptureActive: false });

        // And a stale open source cannot resurrect capture once the attempt is
        // gone: both halves of the predicate are load-bearing.
        expect(resolveVoiceEnergyRuntimeActivation({
            providerId: PROVIDER,
            status: 'disconnected',
            inputSourceActive: true,
        })).toEqual({ providerReady: true, attemptActive: false, micCaptureActive: false });
    });

    it('ends the attempt on disconnect and on error', () => {
        // An attempt that failed has ended: §2.4a settles it back to still
        // rather than animating an error banner for as long as it is shown.
        expect(resolveVoiceEnergyRuntimeActivation({
            providerId: PROVIDER,
            status: 'disconnected',
            inputSourceActive: false,
        })).toEqual({ providerReady: true, attemptActive: false, micCaptureActive: false });
        expect(resolveVoiceEnergyRuntimeActivation({
            providerId: PROVIDER,
            status: 'error',
            inputSourceActive: false,
        })).toEqual({ providerReady: true, attemptActive: false, micCaptureActive: false });
    });
});
