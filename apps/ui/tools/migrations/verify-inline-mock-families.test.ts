import { describe, expect, it } from 'vitest';

import {
    createInlineMockVerificationReport,
    parseVerifyInlineMockFamiliesArgs,
    type VerifyInlineMockFamiliesOptions,
} from './verify-inline-mock-families';

describe('parseVerifyInlineMockFamiliesArgs', () => {
    it('parses enforcement and allowlist flags', () => {
        expect(parseVerifyInlineMockFamiliesArgs([
            '--scope',
            'apps/ui/sources',
            '--fail-on-ad-hoc',
            '--fail-on-family',
            'router',
            '--allow-directory',
            'apps/ui/sources/__tests__/routes',
            '--max-ad-hoc',
            '2',
            '--max-total',
            '5',
            '--json',
        ])).toEqual({
            scope: 'apps/ui/sources',
            top: 20,
            json: true,
            failOnAdHoc: true,
            failOnFamilies: ['router'],
            allowDirectories: ['apps/ui/sources/__tests__/routes'],
            maxAdHoc: 2,
            maxTotal: 5,
        } satisfies VerifyInlineMockFamiliesOptions);
    });
});

describe('createInlineMockVerificationReport', () => {
    it('ignores allowlisted directories when computing enforcement violations', () => {
        const report = createInlineMockVerificationReport([
            {
                path: 'apps/ui/sources/components/example.test.tsx',
                directory: 'apps/ui/sources/components',
                family: 'example',
                area: 'other',
                counts: {
                    files: 1,
                    rendererCreate: 0,
                    renderScreen: 0,
                    standardCleanup: 0,
                    testkitImports: 1,
                    useFakeTimers: 0,
                    advanceTimers: 0,
                    microtaskFlush: 0,
                    requestAnimationFrame: 0,
                    toJSON: 0,
                    onPressTreeWalk: 0,
                    rootTreeWalk: 0,
                    inlineMocks: {
                        reactNative: 0,
                        unistyles: 0,
                        text: 0,
                        modal: 0,
                        router: 1,
                        storage: 0,
                    },
                },
                inlineMockShapes: {
                    total: 1,
                    canonical: 0,
                    adHoc: 1,
                },
                hotspotScore: 1,
                codemodEligible: true,
                codemodBlockers: [],
            },
            {
                path: 'apps/ui/sources/__tests__/routes/example.test.tsx',
                directory: 'apps/ui/sources/__tests__/routes',
                family: 'example',
                area: 'routes',
                counts: {
                    files: 1,
                    rendererCreate: 0,
                    renderScreen: 0,
                    standardCleanup: 0,
                    testkitImports: 1,
                    useFakeTimers: 0,
                    advanceTimers: 0,
                    microtaskFlush: 0,
                    requestAnimationFrame: 0,
                    toJSON: 0,
                    onPressTreeWalk: 0,
                    rootTreeWalk: 0,
                    inlineMocks: {
                        reactNative: 0,
                        unistyles: 0,
                        text: 0,
                        modal: 0,
                        router: 1,
                        storage: 0,
                    },
                },
                inlineMockShapes: {
                    total: 1,
                    canonical: 0,
                    adHoc: 1,
                },
                hotspotScore: 1,
                codemodEligible: true,
                codemodBlockers: [],
            },
        ], {
            scope: 'apps/ui/sources',
            top: 20,
            json: false,
            failOnAdHoc: true,
            failOnFamilies: ['router'],
            allowDirectories: ['apps/ui/sources/__tests__/routes'],
        });

        expect(report.summary.total).toBe(2);
        expect(report.enforced.total).toBe(1);
        expect(report.violations).toEqual([
            'Ad hoc inline mock families remain outside the allowlist (count=1).',
            'Inline mock family "router" remains outside the allowlist (count=1).',
        ]);
    });

    it('fails configured thresholds when the remaining counts exceed them', () => {
        const report = createInlineMockVerificationReport([
            {
                path: 'apps/ui/sources/components/example.test.tsx',
                directory: 'apps/ui/sources/components',
                family: 'example',
                area: 'other',
                counts: {
                    files: 1,
                    rendererCreate: 0,
                    renderScreen: 0,
                    standardCleanup: 0,
                    testkitImports: 1,
                    useFakeTimers: 0,
                    advanceTimers: 0,
                    microtaskFlush: 0,
                    requestAnimationFrame: 0,
                    toJSON: 0,
                    onPressTreeWalk: 0,
                    rootTreeWalk: 0,
                    inlineMocks: {
                        reactNative: 1,
                        unistyles: 0,
                        text: 0,
                        modal: 0,
                        router: 0,
                        storage: 0,
                    },
                },
                inlineMockShapes: {
                    total: 3,
                    canonical: 1,
                    adHoc: 2,
                },
                hotspotScore: 3,
                codemodEligible: true,
                codemodBlockers: [],
            },
        ], {
            scope: 'apps/ui/sources',
            top: 20,
            json: false,
            failOnAdHoc: false,
            failOnFamilies: [],
            allowDirectories: [],
            maxAdHoc: 1,
            maxTotal: 2,
        });

        expect(report.violations).toEqual([
            'Ad hoc inline mock count 2 exceeds max allowed 1.',
            'Total inline mock count 3 exceeds max allowed 2.',
        ]);
    });
});
