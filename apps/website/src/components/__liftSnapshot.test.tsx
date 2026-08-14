/* SCRATCH — created by the i18n lift task to prove rendered output is unchanged.
   Delete when done. */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'vitest';

import { ROUTES } from '../routes';
import { HandoffToComputer } from './HandoffToComputer';
import { VerifyInstaller } from './VerifyInstaller';
import { PrimaryCta } from './PrimaryCta';
import { DownloadBadges } from './DownloadBadges';
import { ProofStrip } from './ProofStrip';
import { ProviderMarkRow } from './ProviderMarkRow';
import { HappierMark } from './HappierMark';
import { AnalyticsNotice } from './AnalyticsNotice';
import { MobileThemePreview } from '../sections/heroShowcase/MobileThemePreview';
import { ThemeProvider } from './ThemeContext';

const OUT = process.env.LIFT_SNAPSHOT_OUT ?? '/tmp/lift-snapshot.txt';

const EXTRAS: ReadonlyArray<[string, () => React.ReactElement]> = [
    ['component:HandoffToComputer', () => <HandoffToComputer />],
    ['component:VerifyInstaller', () => <VerifyInstaller />],
    ['component:VerifyInstaller(win)', () => <VerifyInstaller windowsShell />],
    ['component:PrimaryCta', () => <PrimaryCta />],
    ['component:DownloadBadges', () => <DownloadBadges />],
    ['component:ProofStrip', () => <ProofStrip />],
    ['component:ProviderMarkRow', () => <ProviderMarkRow />],
    ['component:HappierMark', () => <HappierMark />],
    ['component:AnalyticsNotice', () => <AnalyticsNotice />],
    ['component:MobileThemePreview', () => <MobileThemePreview />],
];

it('dumps rendered markup for every route and loose component', () => {
    const chunks: string[] = [];
    for (const route of ROUTES) {
        chunks.push(`===== ${route.path} =====`);
        chunks.push(renderToStaticMarkup(route.render()));
    }
    for (const [name, render] of EXTRAS) {
        chunks.push(`===== ${name} =====`);
        chunks.push(renderToStaticMarkup(<ThemeProvider>{render()}</ThemeProvider>));
    }
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${chunks.join('\n')}\n`, 'utf8');
});
