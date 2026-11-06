import { describe, expect, it } from 'vitest';
import { appListingCatalogFacts, appListingProse } from './storeAppListingFacts';

const catalog = { title: 'Dokploy templates', url: 'https://templates.dokploy.com/meta.json' };

describe('appListingCatalogFacts', () => {
  it.each(['860e786', 'sha256:659211bcb2a6fc35a35da769d185715b96e6be03ba37dce2ddf703a20640f14d'])(
    'never shows a catalog pin as the App version (%s)', (version) => {
      expect(appListingCatalogFacts({ version, catalog }).version).toBeNull();
    });

  it('keeps a real version', () => {
    expect(appListingCatalogFacts({ version: '2.0.2', catalog }).version).toBe('2.0.2');
  });

  it('names the catalog instead of linking its index as if it were the App', () => {
    expect(appListingCatalogFacts({ repository: catalog.url, catalog })).toMatchObject({ repository: null, sourceTitle: 'Dokploy templates' });
  });

  it('keeps the App repository when it is its own', () => {
    expect(appListingCatalogFacts({ repository: 'https://github.com/louislam/uptime-kuma', catalog }))
      .toMatchObject({ repository: 'https://github.com/louislam/uptime-kuma', sourceTitle: 'Dokploy templates' });
  });

  it('keeps a short summary as the purpose and moves a long one into the body, where it reads in full', () => {
    expect(appListingProse({ summary: 'Watch your sites.', about: 'The long story.' })).toEqual({ purpose: 'Watch your sites.', about: 'The long story.' });
    const long = 'Uptime Kuma is an open-source monitoring tool that tracks the uptime of your websites and services. Self-host it on your own server.';
    expect(appListingProse({ summary: long, about: null })).toEqual({ purpose: null, about: long });
    expect(appListingProse({ summary: long, about: long })).toEqual({ purpose: null, about: long });
  });
});
