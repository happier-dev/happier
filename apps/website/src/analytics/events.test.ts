import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EVENT_NAMES, SECTION_NAMES } from './events';
import { INGEST_ORIGIN, POSTHOG_EU_ORIGIN, UI_ORIGIN } from './config';

const SRC = path.resolve(__dirname, '..');

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
    });
}

/** Comments are stripped so a doc comment naming an anti-pattern is not a hit. */
function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SOURCES = walk(SRC).map((file) => {
    const text = readFileSync(file, 'utf8');
    return { file, text, code: stripComments(text) };
});

describe('analytics taxonomy', () => {
    // The mobile app reads its PostHog host from EXPO_PUBLIC_POSTHOG_HOST and
    // falls back to us.i.posthog.com (apps/ui/sources/track/tracking.ts:27)
    // while project 129992 is on EU cloud. That class of mistake is a one-line
    // test away from being impossible on the web.
    it('never points ingest at a US or unspecified PostHog host', () => {
        expect(POSTHOG_EU_ORIGIN).toBe('https://eu.i.posthog.com');
        expect(UI_ORIGIN).toBe('https://eu.posthog.com');
        expect(INGEST_ORIGIN.startsWith('https://happier.dev/')).toBe(true);

        for (const { file, code } of SOURCES) {
            expect(code, `${file} references a non-EU PostHog host`).not.toMatch(
                /us\.i\.posthog\.com|app\.posthog\.com/,
            );
        }
    });

    // src/analytics/analytics.ts is the only module allowed to touch posthog-js.
    // Everything else goes through the typed emitters, which is what keeps the
    // taxonomy answerable by reading one file.
    it('routes every capture through the typed emitters', () => {
        const offenders = SOURCES.filter(
            ({ file, code }) =>
                !file.endsWith(path.join('analytics', 'analytics.ts')) &&
                /posthog\.capture\(|from ['"]posthog-js/.test(code),
        ).map(({ file }) => path.relative(SRC, file));

        expect(offenders).toEqual([]);
    });

    it('emits only names declared in EVENT_NAMES', () => {
        const declared = new Set<string>(EVENT_NAMES);
        const emitted = new Set<string>();

        const trackFile = SOURCES.find(({ file }) =>
            file.endsWith(path.join('analytics', 'events.ts')),
        );
        for (const match of trackFile!.code.matchAll(/\btrack\(\s*'([a-z_]+)'/g)) {
            emitted.add(match[1]!);
        }

        expect([...emitted].sort()).toEqual([...declared].sort());
    });

    /**
     * The failure this catches is the one that had actually happened: nine typed
     * emitters, a passing taxonomy test, and NOT ONE call site. `events.ts`
     * described a measurement plan rather than implementing one, and every test
     * above passes just as happily on a file nothing imports.
     *
     * PostHog has never received a $pageview from any Happier web property. The
     * cheapest way to repeat that is to add a tenth emitter and forget to call
     * it, so: every event name must be reachable from a component.
     */
    it('has a real call site for every event it declares', () => {
        // event name -> the exported emitter a component is expected to import.
        const EMITTERS: Record<string, string> = {
            install_command_copied: 'trackInstallCommandCopied',
            download_badge_clicked: 'trackDownloadBadgeClicked',
            cta_clicked: 'trackCtaClicked',
            outbound_click: 'trackOutboundClick',
            theme_toggled: 'trackThemeToggled',
            section_viewed: 'trackSectionViewed',
            faq_opened: 'trackFaqOpened',
            comparison_viewed: 'trackComparisonViewed',
            demo_played: 'trackDemoPlayed',
        };

        expect(Object.keys(EMITTERS).sort()).toEqual([...EVENT_NAMES].sort());

        const callers = SOURCES.filter(
            ({ file }) => !file.endsWith(path.join('analytics', 'events.ts')),
        );

        const unwired = Object.entries(EMITTERS)
            .filter(([, emitter]) => !callers.some(({ code }) => code.includes(`${emitter}(`)))
            .map(([event]) => event);

        expect(
            unwired,
            'These events are declared, typed and tested, and nothing emits them. ' +
                'An event with no call site is a measurement plan, not a measurement.',
        ).toEqual([]);
    });

    // A `data-section` typo would silently drop a step out of the scroll funnel,
    // and a dropped step looks exactly like a section nobody reaches.
    it('keeps every data-section attribute inside SECTION_NAMES', () => {
        const known = new Set<string>(SECTION_NAMES);
        const found = new Set<string>();

        for (const { code } of SOURCES) {
            for (const match of code.matchAll(/data-section=["']([a-z-]+)["']/g)) {
                found.add(match[1]!);
            }
        }

        for (const name of found) expect(known.has(name), `unknown data-section="${name}"`).toBe(true);
    });
});
