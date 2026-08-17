export const stageVisualTokens = {
    orientation: {
        default: 'narration-right',
    },
    horizon: {
        dark: {
            skyGradient: 'linear-gradient(180deg, #050508 0%, #0A0A10 100%)',
            backgroundColor: '#050508',
            backgroundColorTransparent: 'rgba(5,5,8,0)',
            atmosphereColor: 'rgba(109,148,255,.28)',
            bloomColor: 'rgba(255,177,74,.18)',
        },
        light: {
            skyGradient: 'linear-gradient(180deg, #FAF9F7 0%, #F3EDE6 100%)',
            backgroundColor: '#FAF9F7',
            backgroundColorTransparent: 'rgba(250,249,247,0)',
            atmosphereColor: 'rgba(255,177,74,.24)',
            bloomColor: 'rgba(255,177,74,.20)',
        },
        /**
         * The journey and the pre-auth welcome screen share ONE planet framing
         * recipe (spec §1): full-bleed cover anchored at `80% 50%`, which reads
         * as a LOW HORIZON cropped by the bottom/right of the section. The
         * earlier journey-only `142% auto` / `center 86%` pair overflowed the
         * pane horizontally and anchored the disc centred, so it read as a
         * floating ball cut off at the narration divider.
         *
         * `StagePane` now renders the canonical `PlanetBackground variant="desktop"`
         * call the brand pane makes, so nothing selects the `horizon`
         * composition any more; these values keep that composition on the
         * canonical framing for as long as `PlanetBackground` still carries it.
         */
        planetBackgroundSize: 'cover',
        planetBackgroundPosition: '80% 50%',
        /**
         * Bottom fade over the stage canvas: transparent -> the pane's own
         * background over the lower 55%, the same R1 recipe `BrandPanel` draws
         * over the brand pane (spec §1). It grounds the planet and keeps the
         * bottom edge of the pane from reading as a hard cut.
         */
        bottomFadeHeight: '55%',
        accentTransitionMs: 800,
        idleBreath: {
            durationMs: 20_000,
            scalePeak: 1.012,
            bloomOpacityDelta: 0.1,
        },
        noiseOpacity: 0.02,
        noiseTileSize: 16,
        noiseTileDataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACbklEQVR4nDWT127rMBBE9alxYsex4yJ2UmIxVRgVSvzliwF8HwQQ4pbZs8NKCHETQtyVUsFa+8EY05RS1ratyTl/1HV9eL1eR0opjTE+932XwzCcc85nSimpcEDgMAwH772ilNb4SikNpZTHGB/TNB201l/jOF4ppUpKydGw7/u2Ukp5HIZh+Cil2Gmavkspbl3XJqVE0KDrOmGM+d33XXRdRxC/rqvd951XCF6WRfR975um4UKIJ+QTQh7rujohxKVtWwQj0ez7zjAWIeQGNdU0TSfvPcfs4zjet227LcvCUkp027arEOIB6UqpNsZ4zzkf6ro+/Y8Bg493B4aulFIJeVrrk7X2bK39XJZFggMK5Zy/jDFPFFRKmYoQci+l+HmeH9baE2ThYtu2p5SSgHzXdYDq//7+Gikl5Zx/ghmaVph727bfpmko4DjnHkhY11WHEALGcs7dcfd6vU4YA2MSQn7QvFqWhVtrDyEEbMPFGC+lFOO9Z6CcUhIhBANWOedjXddfyHHOXYdhOFVd1zHMXEoJgInu2P0bEnHOPZEcQtD4N8/z1RhzB0gArYwxoHxBQNM0tVJKY17sHAC11gcoQtcQQlPX9RmmG8fxhv8ocEWXtxc0oAEkpVSgICRDunPuB26EjTEmYpBbgSjcByO9twEjtTij8DzPgPULgPAF5/yUUmJSSig8VqA7TdNRa/0ZY/zBwwJpbMd7T1NK8L6KMd5wjyT4BiMzxlyFFSEBVMECZoHUtyP5siwUCv4/Jjw4rFgI8dP3fagYY23OGbDOxpgLzt57iRn3fa/neUaDG7rhjaAA5/w7pQSF6h8uPvCkmGdInQAAAABJRU5ErkJggg==',
    },
    appShell: {
        sidebarWidth: 420,
    },
    desktopWindow: {
        logicalWidth: 1280,
        logicalHeight: 800,
        preferredWidthRatio: 0.78,
        minWidthRatio: 0.74,
        maxWidthRatio: 0.8,
        minPaneMarginRatio: 0.05,
        opticalCenterYRatio: 0.46,
        radius: 14,
        trafficLightSize: 12,
        trafficLightGap: 8,
        trafficLightInset: 16,
        // Top inset for the decorative traffic-light overlay. The real app draws
        // OS overlay controls centered in a ~28px control slot (top padding 2);
        // 18px places the 12px dots at that optical center over the sidebar head.
        trafficLightOverlayTop: 18,
        trafficRed: '#FF5F57',
        trafficYellow: '#FEBC2E',
        trafficGreen: '#28C840',
        trafficRingColor: 'rgba(0,0,0,.20)',
        darkBorderColor: 'rgba(255,255,255,.09)',
        lightBorderColor: 'rgba(0,0,0,.07)',
        darkSurfaceColor: 'rgba(13,14,20,.78)',
        lightSurfaceColor: 'rgba(255,255,255,.84)',
        darkShadow: '0 32px 96px -16px rgba(4,8,24,.42), 0 2px 10px rgba(0,0,0,.22)',
        lightShadow: '0 32px 88px -20px rgba(30,20,10,.25), 0 2px 8px rgba(0,0,0,.10)',
        webBackdropFilter: 'blur(20px) saturate(1.4)',
    },
    phoneFrame: {
        logicalWidth: 390,
        logicalHeight: 844,
        outerRadius: 54,
        screenRadius: 44,
        maxPaneHeightRatio: 0.78,
        bezelColor: '#0B0B0F',
        edgeColor: 'rgba(255,255,255,.06)',
        notchWidth: 126,
        notchHeight: 37,
        notchTop: 14,
        sideButtonWidth: 3,
    },
    narration: {
        width: 440,
        minWidth: 400,
        maxWidth: 460,
        referencePaneHeight: 900,
        topBlockOffsetRatio: 0.18,
        actionBaselineBottomRatio: 0.16,
        locatorFontSize: 11,
        locatorLetterSpacing: 0.88,
        locatorRuleWidth: 24,
        /**
         * The beat headline is the same display type as the welcome screen's
         * `BrandTagline` (48 / 48 / -1.8) — beat A1's copy is literally the
         * brand tagline, and every beat is written as a lead + closing sentence
         * pair for the same two-tone treatment. Leading equals the font size so
         * the two tones stack as one block, exactly like the brand pane.
         */
        titleFontSize: 48,
        titleLineHeight: 48,
        titleLetterSpacing: -1.8,
        /** Display headline -> body gap; mirrors the brand pane's tagline block. */
        titleBodyGap: 22,
        bodyFontSize: 17,
        bodyLineHeight: 27.2,
        bodyMaxWidth: 578,
        primaryHeight: 44,
        primaryRadius: 22,
        primaryPaddingHorizontal: 20,
        primaryFontSize: 15,
        activeDotWidth: 16,
        inactiveDotSize: 4,
        dotGap: 8,
        trailingRailWidth: 136,
    },
    motion: {
        beatTransitionMs: 800,
        skipTransitionMs: 240,
        hoverMs: 120,
        hoverTranslateY: -1,
        pressScale: 0.97,
        springDamping: 18,
        springStiffness: 320,
        focusRingWidth: 2,
        focusRingAlpha: 0.4,
    },
} as const;
