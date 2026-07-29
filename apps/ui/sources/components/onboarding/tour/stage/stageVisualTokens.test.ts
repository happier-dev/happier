import { describe, expect, it } from 'vitest';

import { stageVisualTokens } from './stageVisualTokens';

describe('stageVisualTokens', () => {
    it('pins the binding STAGEVISUAL2 split, horizon, frame, and motion values', () => {
        expect(stageVisualTokens.orientation.default).toBe('narration-right');

        expect(stageVisualTokens.horizon.dark.skyGradient).toBe('linear-gradient(180deg, #050508 0%, #0A0A10 100%)');
        expect(stageVisualTokens.horizon.light.skyGradient).toBe('linear-gradient(180deg, #FAF9F7 0%, #F3EDE6 100%)');
        expect(stageVisualTokens.horizon.planetVisibleDiscRatio).toEqual({
            min: 0.55,
            max: 0.65,
        });
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
});
