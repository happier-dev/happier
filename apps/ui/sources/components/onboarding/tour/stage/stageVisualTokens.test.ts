import { describe, expect, it } from 'vitest';

import { stageVisualTokens } from './stageVisualTokens';

describe('stageVisualTokens', () => {
    it('pins the binding STAGEVISUAL2 split, horizon, frame, and motion values', () => {
        expect(stageVisualTokens.orientation.default).toBe('narration-right');

        expect(stageVisualTokens.horizon.dark.skyGradient).toBe('linear-gradient(180deg, #050508 0%, #0A0A10 100%)');
        expect(stageVisualTokens.horizon.light.skyGradient).toBe('linear-gradient(180deg, #FAF9F7 0%, #F3EDE6 100%)');
        expect(stageVisualTokens.horizon.idleBreath).toMatchObject({
            durationMs: 20_000,
            scalePeak: 1.012,
            bloomOpacityDelta: 0.1,
        });
        expect(stageVisualTokens.horizon.noiseOpacity).toBe(0.02);
        expect(stageVisualTokens.horizon.noiseTileDataUri).toMatch(/^data:image\/png;base64,/);

        expect(stageVisualTokens.desktopWindow).toMatchObject({
            preferredWidthRatio: 0.78,
            minWidthRatio: 0.74,
            maxWidthRatio: 0.8,
            minPaneMarginRatio: 0.05,
            opticalCenterYRatio: 0.46,
            radius: 14,
            trafficLightSize: 12,
            trafficLightGap: 8,
            trafficLightInset: 16,
            trafficLightOverlayTop: 18,
            trafficYellow: '#FEBC2E',
            webBackdropFilter: 'blur(20px) saturate(1.4)',
            darkBorderColor: 'rgba(255,255,255,.09)',
            lightBorderColor: 'rgba(0,0,0,.07)',
            darkShadow: '0 32px 96px -16px rgba(4,8,24,.42), 0 2px 10px rgba(0,0,0,.22)',
            lightShadow: '0 32px 88px -20px rgba(30,20,10,.25), 0 2px 8px rgba(0,0,0,.10)',
        });

        expect(stageVisualTokens.phoneFrame).toMatchObject({
            logicalWidth: 390,
            logicalHeight: 844,
            outerRadius: 54,
            screenRadius: 44,
            maxPaneHeightRatio: 0.78,
            bezelColor: '#0B0B0F',
            edgeColor: 'rgba(255,255,255,.06)',
        });

        expect(stageVisualTokens.narration).toMatchObject({
            width: 440,
            minWidth: 400,
            maxWidth: 460,
            topBlockOffsetRatio: 0.18,
            actionBaselineBottomRatio: 0.16,
            locatorRuleWidth: 24,
            primaryHeight: 44,
            primaryRadius: 22,
            activeDotWidth: 16,
            inactiveDotSize: 4,
            trailingRailWidth: 136,
        });

        expect(stageVisualTokens.motion).toMatchObject({
            beatTransitionMs: 800,
            skipTransitionMs: 240,
            hoverMs: 120,
            hoverTranslateY: -1,
            pressScale: 0.97,
            springDamping: 18,
            springStiffness: 320,
            focusRingWidth: 2,
            focusRingAlpha: 0.4,
        });
    });

    it('shares ONE planet framing recipe and display headline scale with the welcome brand pane', () => {
        // The welcome screen's `PlanetBackground variant="desktop"` recipe:
        // full-bleed cover anchored at 80%/50% so the disc reads as a LOW
        // HORIZON (spec §1). The journey must not run a second framing.
        expect(stageVisualTokens.horizon.planetBackgroundSize).toBe('cover');
        expect(stageVisualTokens.horizon.planetBackgroundPosition).toBe('80% 50%');

        // BrandTagline's desktop display scale (48 / 48 / -1.8).
        expect(stageVisualTokens.narration.titleFontSize).toBe(48);
        expect(stageVisualTokens.narration.titleLineHeight).toBe(48);
        expect(stageVisualTokens.narration.titleLetterSpacing).toBe(-1.8);
    });

    it('carries the bottom-fade recipe the stage pane needs and drops tokens with no reader', () => {
        // R1/BrandPanel's desktop bottom fade: transparent -> canvas over 55%.
        expect(stageVisualTokens.horizon.bottomFadeHeight).toBe('55%');
        expect(stageVisualTokens.horizon.dark.backgroundColorTransparent).toBe('rgba(5,5,8,0)');
        expect(stageVisualTokens.horizon.light.backgroundColorTransparent).toBe('rgba(250,249,247,0)');

        // Dead tokens: the planet disc-ratio never had a production reader, and
        // the ACT eyebrow row was killed by D17 and stays unrendered.
        expect(stageVisualTokens.horizon).not.toHaveProperty('planetVisibleDiscRatio');
        expect(stageVisualTokens.narration).not.toHaveProperty('eyebrowFontSize');
        expect(stageVisualTokens.narration).not.toHaveProperty('eyebrowLetterSpacing');
    });
});
