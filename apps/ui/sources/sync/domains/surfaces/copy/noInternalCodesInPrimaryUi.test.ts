import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as React from 'react';
import { describe, expect, it } from 'vitest';

/**
 * §5.2 — the "no internal states in product UI" closure gate this packet owns.
 *
 * Asserts that no primary-UI browser surface interpolates a raw reason /
 * lastError / surface-state token into a `t(...)` call, that the raw-code
 * translation keys were deleted by exact key name, that the new neutral
 * empty-state keys exist, and that every reason-code surface routes through the
 * ONE mapper at `@/sync/domains/surfaces/copy` (DV-COPY-LOC).
 */

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES_ROOT = resolve(here, '../../../..'); // .../apps/ui/sources
const read = (relative: string) => readFileSync(resolve(SOURCES_ROOT, relative), 'utf8');

// The five primary browser surfaces this packet migrates.
const FRAME = 'components/browser/frame/BrowserFrameUnavailable.tsx';
const STATUS_BAR = 'components/browser/BrowserStatusBar.tsx';
const SURFACE_FALLBACK = 'components/browser/surfaces/BrowserSurfaceFallback.tsx';
const TARGET_CARD = 'components/browser/launchpad/BrowserTargetCard.tsx';
// The origin chip was merged into the security indicator (one identity chip, not two pills).
const ORIGIN_CHIP = 'components/browser/toolbar/SecurityOriginIndicator.tsx';

// Surfaces that turn a reason/lastError/surface-state token into copy: they MUST
// route through the mapper. (The origin chip renders a static neutral key, so it
// does not consume the mapper — it is asserted separately below.)
const MAPPER_SURFACES = [FRAME, STATUS_BAR, SURFACE_FALLBACK, TARGET_CARD] as const;
const ALL_SURFACES = [FRAME, STATUS_BAR, SURFACE_FALLBACK, TARGET_CARD, ORIGIN_CHIP] as const;

describe('no internal reason codes in primary browser UI (§5.2)', () => {
    it('no primary surface interpolates a raw reason/lastError/state token into t(...)', () => {
        for (const file of ALL_SURFACES) {
            const source = read(file);
            expect(source, `${file} must not call the deleted raw-code key`).not.toContain("t('browserShell.status.error'");
            expect(source, `${file} must not call the deleted launchpad raw key`).not.toContain("t('browserLaunchpad.status.unavailable'");
            expect(source, `${file} must not call the deleted origin debug key`).not.toContain("t('browserShell.origin.empty'");
            // No reasonCode/reason interpolation argument passed into a t(...) call.
            expect(source, `${file} must not pass a reasonCode into t(...)`).not.toMatch(/t\([^)]*\{\s*reasonCode:/);
            expect(source, `${file} must not pass a reason into t(...)`).not.toMatch(/t\([^)]*\{\s*reason:/);
        }
    });

    it('every reason-code surface imports the ONE mapper from @/sync/domains/surfaces/copy', () => {
        for (const file of MAPPER_SURFACES) {
            const source = read(file);
            expect(source, `${file} must consume the canonical mapper`).toContain("from '@/sync/domains/surfaces/copy'");
            expect(source).toContain('resolveReasonCopy');
        }
    });

    it('no non-test file imports a reason-copy mapper from the wrong (browser-domain) location', () => {
        for (const file of ALL_SURFACES) {
            const source = read(file);
            expect(source, `${file} pins DV-COPY-LOC`).not.toContain('sync/domains/browser/copy');
        }
    });

    it('the origin chip renders the neutral newTab key, not the deleted debug string', () => {
        const source = read(ORIGIN_CHIP);
        expect(source).toContain("t('browserShell.origin.newTab')");
        expect(source).not.toContain("t('browserShell.origin.empty')");
    });

    it('deleted raw-interpolating keys are absent by exact key name (en + a second locale)', () => {
        for (const locale of ['en', 'es']) {
            const source = read(`text/translations/${locale}.ts`);
            // Exact key-name assertions (NOT the shared `Unavailable: ${reason}` body,
            // which is ambiguous between launchpad and launcher namespaces).
            expect(source, `${locale}: browserShell.status.error key body removed`).not.toMatch(/error: \(\{ reasonCode \}[^\n]*Browser/);
            expect(source, `${locale}: browserShell.origin.empty removed`).not.toMatch(/origin: \{[\s\S]{0,200}?\bempty:/);
            // browserLaunchpad.status.unavailable + localServices.launcher.status.unavailable
            // shared the `Unavailable: ${reason}` body; both are gone now.
            expect(source, `${locale}: shared raw "Unavailable" body removed`).not.toContain('`Unavailable: ${reason}`');
        }
    });

    it('the new neutral keys are present and distinct from the unrelated tabs.newTab key', () => {
        const en = read('text/translations/en.ts');
        // origin.newTab is a NEW key in the origin block, distinct from tabs.newTab.
        expect(en).toMatch(/origin: \{[\s\S]{0,200}?newTab:/);
        expect(en).toMatch(/tabs: \{[\s\S]{0,80}?newTab:/);
        expect(en).toMatch(/status: \{[\s\S]{0,400}?empty: 'No page loaded\./);
        expect(en).toMatch(/privacy: \{[\s\S]{0,80}?title:/);
    });
});

describe('migrated surfaces render product copy, raw codes only in diagnostics (§5.2)', () => {
    it('BrowserFrameUnavailable shows no raw code in text, keeps it in the diagnostics test-id', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { BrowserFrameUnavailable } = await import('@/components/browser/frame/BrowserFrameUnavailable');
        const screen = await renderScreen(
            React.createElement(BrowserFrameUnavailable, { testID: 'frame', reasonCode: 'external_url_unavailable' }),
        );
        expect(screen.getTextContent()).not.toContain('external_url_unavailable');
        // The raw code stays reachable for QA via the SurfaceStateCard diagnostics
        // testID channel (L0-2 unified rendering).
        expect(screen.findByTestId('frame-unavailable-diagnostic-external_url_unavailable')).toBeTruthy();
    });

    it('BrowserSurfaceFallback shows no raw surface-state token in text', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { BrowserSurfaceFallback } = await import('@/components/browser/surfaces/BrowserSurfaceFallback');
        const screen = await renderScreen(React.createElement(BrowserSurfaceFallback, { reason: 'host_lost' }));
        expect(screen.getTextContent()).not.toContain('host_lost');
    });

    it('BrowserTargetCard shows no raw disabledReason token in the row detail', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { BrowserTargetCard } = await import('@/components/browser/launchpad/BrowserTargetCard');
        const row = {
            id: 'unavailable:blocked',
            section: 'unavailable',
            sourceKind: 'recent',
            title: 'Blocked target',
            subtitle: 'blocked.example',
            detail: 'external_url_policy_denied',
            target: null,
            disabledReason: 'external_url_policy_denied',
            lastSeenAt: 1_000,
        } satisfies import('@/sync/domains/browser/targets').BrowserLaunchpadRow;
        const screen = await renderScreen(
            React.createElement(BrowserTargetCard, { row, testID: 'card' }),
        );
        expect(screen.getTextContent()).not.toContain('external_url_policy_denied');
    });
});
