import { describe, expect, it } from 'vitest';
import { transform } from 'esbuild';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfile } from '@happier-dev/protocol/account/projectPublicProfile';
import { PublicProfileLayoutV1Schema, PublicProfileViewV1Schema, PUBLIC_USAGE_CHART_COPY_EN } from '@happier-dev/protocol/account/publicProfilePublication';
import { renderPublicProfileHtml } from './publicProfileHtml';
import { publicProfilePageLabels } from './publicProfileLabels';

function published(tokens = true) {
    const view = projectPublicProfile({ context: { handle: 'nadia', identity: { name: '<Nadia> Müller' },
        service: { displayName: 'My Home', publicBaseUrl: 'https://profiles.example/prefix' },
        urls: { page: 'https://profiles.example/prefix/@nadia', json: 'https://profiles.example/prefix/v1/public/profiles/nadia',
            badgeBase: 'https://profiles.example/prefix/@nadia/badge', card: 'https://profiles.example/prefix/@nadia/card.svg',
            og: 'https://profiles.example/prefix/@nadia/og.png', report: 'mailto:operator@example.test' } },
        policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens } },
        metadata: {}, appearance: { theme: 'auto', atmosphere: { source: 'none' } },
        layout: PublicProfileLayoutV1Schema.parse({ v: 1, items: [{ kind: 'widget', id: 'summary', title: 'Shared work', size: 'medium', frameStyle: 'card',
            presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Tokens',
                data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'tokens'], type: 'number' } } } } }] }),
        snapshot: PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 2000,
            period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 120 }, coverage: { status: 'partial', method: 'runtime' },
            fieldCoverage: {}, facts: { tokens: 987654321 } }) });
    if (!view) throw new Error('Expected admitted fixture');
    return { kind: 'published', view } as const;
}

describe('cold public-profile document', () => {
    it('keeps shared Totals figures visible when their evidence is unavailable', () => {
        const { view } = published();
        const totals = PublicProfileViewV1Schema.parse({ ...view,
            snapshot: { ...view.snapshot, facts: { tokens: 321 }, fieldCoverage: {
                agentTime: { status: 'unavailable', method: 'unknown' },
                mergedPrs: { status: 'unavailable', method: 'unknown' },
                peakParallel: { status: 'unavailable', method: 'unknown' },
            } },
            layout: { v: 1, items: [{ kind: 'widget', id: 'totals', title: 'Totals', size: 'full', frameStyle: 'plain',
                presentation: { kind: 'usage', widgetId: 'usage_period_summary', inputs: {} } }] },
        });
        const html = renderPublicProfileHtml({ kind: 'published', view: totals });
        expect(html.includes('Agent time'), 'shared Agent time remains visible').toBe(true);
        expect(html.includes('Linked merged pull requests'), 'shared Merged PRs remains visible').toBe(true);
        expect(html.includes('Peak parallel'), 'shared Peak parallel remains visible').toBe(true);
    });

    it('uses the declared contributed Agent name in the generated cold Crew renderer', () => {
        const { view } = published();
        const crew = PublicProfileViewV1Schema.parse({ ...view,
            snapshot: { ...view.snapshot, facts: { ...view.snapshot.facts,
                agentMix: [{ agentId: 'custom-acp', share: 1, coverage: { status: 'partial', method: 'runtime' } }] } },
            layout: { v: 1, items: [{ kind: 'widget', id: 'crew', title: 'Crew', size: 'medium', frameStyle: 'plain',
                presentation: { kind: 'usage', widgetId: 'usage_breakdowns', inputs: { style: 'crew' } } }] },
        });
        const html = renderPublicProfileHtml({ kind: 'published', view: crew });
        expect(html).toContain('Custom ACP Agent');
        expect(html).not.toContain('Custom Acp');
    });

    it('shows the handle once when no display name is shared, keeping the service and membership date', () => {
        const { view } = published();
        view.identity = { sinceMs: Date.UTC(2026, 2, 1) };
        expect(publicProfilePageLabels(view).identityLine).toBe('My Home · since March 2026');
        const html = renderPublicProfileHtml({ kind: 'published', view });
        const names = [...html.matchAll(/data-testid="public-profile-name"[^>]*>([^<]*)</g)].map(match => match[1]);
        expect(names.length).toBeGreaterThan(0);
        expect(new Set(names)).toEqual(new Set(['@nadia']));
        expect(html.split('<body>')[1]).not.toContain('@nadia · My Home');
        view.identity.name = 'Nadia';
        expect(publicProfilePageLabels(view).identityLine).toBe('@nadia · My Home · since March 2026');
    });
    it.each([
        ['usage_daily', {}], ['usage_period_summary', {}], ['usage_footprint', {}], ['usage_source_coverage', {}],
        ['usage_rhythm', { style: 'heatmap' }], ['usage_rhythm', { style: 'weekdayHour' }],
        ['usage_breakdowns', { style: 'breakdowns' }], ['usage_outcomes', { style: 'outcomes' }],
        ['usage_recap', { style: 'recap' }],
    ])('cold-renders admitted original %s %j through a shared body', (widgetId, inputs) => {
        const result = published();
        const view = PublicProfileViewV1Schema.parse({ ...result.view,
            snapshot: { ...result.view.snapshot,
                period: { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2026, 0, 4), timeZoneOffsetMinutes: 0 },
                facts: { tokens: 321, activeDays: 2, mergedPrs: 0, currentStreakDays: 1, bestStreakDays: 2,
                    agentTimeMs: 60000, peakParallel: 2,
                    calendar: [{ date: '2026-01-01', level: 4 }, { date: '2026-01-02', level: null }, { date: '2026-01-03', level: 0 }],
                    punch: [{ weekday: 1, hour: 10, level: 3 }],
                    agentMix: [{ agentId: 'codex', share: 1, coverage: { status: 'partial', method: 'runtime' } }],
                    sourceSplit: [{ execution: 'happier', share: 1 }],
                    footprint: { status: 'insufficient_basis', reason: 'no_applicable_versioned_method' },
                    highlights: [{ kind: 'active_days', count: 2 }],
                } },
            layout: { v: 1, items: [{ kind: 'widget', id: 'original', title: 'Shared original', size: 'wide', frameStyle: 'plain',
                presentation: { kind: 'usage', widgetId, inputs } }] },
        });
        const html = renderPublicProfileHtml({ kind: 'published', view });
        expect(html).toContain('Shared original');
        expect(html).toContain('data-testid="public-profile-usage-original');
        expect(html).not.toContain('data-testid="public-profile-usage-original-unavailable"');
        expect(html).not.toContain('<script');
        if (widgetId === 'usage_daily' || widgetId === 'usage_rhythm') {
            expect(html).toContain('Activity level');
        }
        if (widgetId === 'usage_footprint') expect(html).toContain('No estimate');
        if (widgetId === 'usage_outcomes') expect(html).toContain('0');
    });
    it('contains the actual placed shared body and CSS before client layout or hydration, using prefixed server-owned font and metadata URLs', () => {
        const html = renderPublicProfileHtml(published());
        expect(html).toContain('Shared work');
        expect(html).toContain('987,654,321');
        expect(html).toContain('&lt;Nadia&gt; Müller');
        expect(html).toContain('[stylesheet-group=');
        expect(html).toContain('https://profiles.example/prefix/v1/public/profiles/assets/fonts/Inter-Regular.ttf');
        expect(html).toContain('https://profiles.example/prefix/@nadia/og.png');
        expect(html).not.toContain('/og.png?v=');
        expect(html).not.toMatch(/<script\b|<Nadia>/);
        expect(html).toContain('noindex,nofollow');
        expect(html.split('<body>')[1]).toContain('font-family:Inter');
    });

    it('never serializes a hidden value, title or copied binding, including accessible markup and metadata', () => {
        const html = renderPublicProfileHtml(published(false));
        expect(html).not.toContain('987654321');
        expect(html).not.toContain('987,654,321');
        expect(html).not.toContain('Shared work');
        expect(html).not.toContain('snapshot.facts.tokens');
    });

    it('honors automatic appearance without hydration and emits a complete stylesheet', async () => {
        const html = renderPublicProfileHtml(published());
        const stylesheet = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
        if (!stylesheet) throw new Error('Expected the cold document stylesheet');
        // CSS parsers recover an unclosed media block at EOF, silently changing
        // the scope of the responsive rules appended after the theme rules.
        const parsed = await transform(stylesheet, { loader: 'css' });
        expect(parsed.warnings).toEqual([]);
        expect(html).toContain('@media(prefers-color-scheme:dark)');
        expect(html).toContain('public-profile-dark');
        expect(html).not.toContain('<script');
    });

    it('defines every atomic class the placed page uses, so its column, gutters and hero offsets paint without hydration', () => {
        const html = renderPublicProfileHtml(published());
        const [head, body] = html.split('</style>');
        const defined = new Set([...(head ?? '').matchAll(/\.(r-[0-9a-z]+)\b/g)].map(match => match[1]));
        const used = [...new Set(body?.match(/\br-[0-9a-z]+\b/g) ?? [])];
        expect(used.length).toBeGreaterThan(0);
        expect(used.filter(name => !defined.has(name))).toEqual([]);
    });

    it('opens a published visitor page with the brand bar: Happier, the service and what Happier is', () => {
        const html = renderPublicProfileHtml(published());
        const bar = html.match(/data-testid="public-profile-brand"[\s\S]*?What is Happier\?/)?.[0] ?? '';
        expect(bar).toContain('Happier');
        expect(bar).toContain('My Home');
        expect(html).toContain('href="https://happier.dev"');
    });

    it('names the period the owner chose above the dates, and keeps a neutral title for a period without a preset', () => {
        const { view } = published();
        const chosen = renderPublicProfileHtml({ kind: 'published', view: PublicProfileViewV1Schema.parse({ ...view, relativePeriod: '30days' }) });
        expect(chosen).toContain('Last 30 days');
        expect(chosen.split('<body>')[1]).not.toContain('Public activity');
        expect(renderPublicProfileHtml({ kind: 'published', view: PublicProfileViewV1Schema.parse({ ...view, relativePeriod: 'year' }) }))
            .toContain('Last year');
        expect(renderPublicProfileHtml(published())).toContain('Public activity');
    });

    it('paints a paused page as its quiet horizon, one line and the identity the owner shares, with no numbers', () => {
        const html = renderPublicProfileHtml({ kind: 'paused', handle: 'nadia', identity: { name: 'Nadia' } }, undefined, { service: 'My Home' });
        expect(html).toContain('Nadia paused this profile');
        expect(html).toContain('Badges read');
        expect(html).toContain('@nadia · My Home');
        expect(html).toMatch(/data-testid="public-profile-hero-band"[^>]*>\s*<svg[\s\S]*?<circle/);
        expect(html).toContain('public-profile-phone');
        expect(html).not.toContain('987,654,321');
        expect(html).not.toContain('<script');
    });

    it('puts the shared planet fallback beside a paused identity', () => {
        const html = renderPublicProfileHtml({ kind: 'paused', handle: 'nadia',
            identity: { name: 'Nadia', avatar: { kind: 'planet', reason: 'account_image_unavailable' } } }, undefined, { service: 'My Home' });
        expect(html).toMatch(/data-testid="public-profile-avatar"[^>]*>\s*<svg[\s\S]*?<circle/);
    });

    it('tells a visitor of a missing profile that there is none here and links what Happier is', () => {
        const html = renderPublicProfileHtml({ kind: 'unavailable' }, undefined, { service: 'My Home' });
        expect(html).toContain('No public profile here');
        expect(html).toContain('Profile unavailable');
        expect(html).toMatch(/<a[^>]*data-testid="public-profile-about"[^>]*>|<a[^>]*href="https:\/\/happier\.dev"[^>]*data-testid="public-profile-about"/);
        expect(html).toContain('My Home');
        expect(html).not.toContain('public-profile-identity');
    });

    it('draws the shared Usage portrait through the real Brand slot without inventing absent public facts', () => {
        const result = published(false);
        const view = PublicProfileViewV1Schema.parse({ ...result.view, layout: { v: 1, items: [
            { kind: 'widget', id: 'portrait', title: 'Shared planet', size: 'medium', frameStyle: 'plain',
                presentation: { kind: 'usage', widgetId: 'usage_planet', inputs: {} } },
        ] } });
        const html = renderPublicProfileHtml({ kind: 'published', view });
        expect(html).toContain('Shared planet');
        expect(html).toContain('Light');
        expect(html).toContain(PUBLIC_USAGE_CHART_COPY_EN.notRecorded);
        expect(html).toContain('<circle');
        expect(html).not.toContain('987,654,321');
        expect(html).not.toContain('<script');
    });

});
