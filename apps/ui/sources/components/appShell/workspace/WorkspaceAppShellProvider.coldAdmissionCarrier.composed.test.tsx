/** @vitest-environment jsdom */
import { it } from 'vitest';

import { expectColdHomeLaunch } from './coldHomeLaunchTestHarness';

it('creates no pool entry and sends no bearer while carrier verification holds across online, recheck, Retry and unmount', async () => {
    await expectColdHomeLaunch('home', { title: 'held-carrier', carrier: { code: 'unavailable', held: true },
        code: 'unavailable', action: 'retry' });
});

it('ignores a prior idle URL/token pool entry while carrier verification is held', async () => {
    await expectColdHomeLaunch('home', { title: 'stale-carrier-entry',
        carrier: { code: 'unavailable', held: true, stalePoolEntry: true }, code: 'unavailable', action: 'retry' });
});

it.each([
    { code: 'unavailable', action: 'retry' },
    { code: 'identity_mismatch', action: 'none' },
] as const)('shows the typed carrier result when the carrier answers $code', async fixture => {
    await expectColdHomeLaunch('home', { title: fixture.code.replaceAll('_', '-'),
        carrier: { code: fixture.code }, ...fixture });
});

it('sends the first authenticated encryption identity read only over the selected Iroh carrier', async () => {
    await expectColdHomeLaunch('home', { title: 'selected-carrier',
        carrier: { code: 'unavailable', held: true, selected: true }, code: 'unavailable', action: 'retry' });
});

it('keeps the unavailable card visible while Retry acquires the carrier again', async () => {
    await expectColdHomeLaunch('home', {
        title: 'unavailable-on-retry', carrier: { code: 'unavailable' },
        code: 'unavailable', action: 'retry', retryPending: true,
    });
});
