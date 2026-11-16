import { expect, it } from 'vitest';
import { parseThemeProfileDocument } from '../account/settings/themeProfiles.js';
import { RegistryThemePayloadV1Schema } from './registryThemeV1.js';

it.each([undefined, 'light'] as const)('retains the admitted face mode over document appearance %s without losing future presentation', (assetAppearance) => {
  const parsed = parseThemeProfileDocument({ schemaVersion: 2, id: 'catalog_night', name: 'Night',
    createdAt: '2026-11-16', updatedAt: '2026-11-16', base: { light: 'light', dark: 'dark' },
    ...(assetAppearance === undefined ? {} : { assetAppearance }),
    overrides: { light: {}, dark: {} }, style: { futureGlow: { amount: 2 } }, futurePresentation: { blur: true } });
  if (!parsed.ok) throw new Error('Invalid theme fixture');
  const ready = RegistryThemePayloadV1Schema.parse({ kind: 'theme', state: 'ready', version: '1',
    listing: { includes: [{ key: 'night', label: 'Night', mode: 'dark' }] },
    themes: [{ key: 'night', label: 'Night', mode: 'dark', document: parsed.document }],
    ref: { kind: 'version', version: '1' } });
  if (ready.state !== 'ready') throw new Error('Expected acquired faces');
  const document = ready.themes[0]!.document;
  expect(document.profile.assetAppearance).toBe('dark');
  expect(document.raw).toMatchObject({ schemaVersion: 2, assetAppearance: 'dark',
    style: { futureGlow: { amount: 2 } }, futurePresentation: { blur: true } });
  expect(document.compatibility.status).toBe('partial');
});
