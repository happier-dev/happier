import { describe, expect, it } from 'vitest';

const { deploymentEnvironmentBands } =
  await import('./DeploymentEnvironmentRows');

type BandRow = Parameters<typeof deploymentEnvironmentBands>[0][number];

const row = (
  projectSourceId: string,
  projectName: string | null,
  title: string,
  tone?: 'danger' | 'warning' | null,
): BandRow & { id: string } => ({
  id: `${projectSourceId}:${title}`,
  projectSourceId,
  projectName,
  title,
  state: tone === undefined ? null : { tone, text: 'state' },
});

describe('deploymentEnvironmentBands (Services → Apps, lab envList)', () => {
  it('bands each Project in the page order, leads with the Projects their one Environment already names, and keeps unnamed last', () => {
    const rows = [
      row('source-shop', 'storefront', 'Staging', 'danger'),
      row('source-gone', null, 'Demo'),
      row('source-maria', 'maria-db', 'maria-db'),
      row('source-shop', 'storefront', 'Production'),
      row('source-api', 'payments-api', 'Production API', null),
    ];
    const bands = deploymentEnvironmentBands(rows);
    expect(bands.axis.map((band) => [band.key, band.title])).toEqual([
      ['single', ''],
      ['source-shop', 'storefront'],
      ['source-api', 'payments-api'],
      ['other', expect.any(String)],
    ]);
    expect(
      rows.map((candidate) => [candidate.id, bands.groupOf(candidate)]),
    ).toEqual([
      ['source-shop:Staging', 'source-shop'],
      ['source-gone:Demo', 'other'],
      ['source-maria:maria-db', 'single'],
      ['source-shop:Production', 'source-shop'],
      ['source-api:Production API', 'source-api'],
    ]);
    // Every band stands on the one sheet.
    expect(new Set(bands.axis.map((band) => band.section.key)).size).toBe(1);
  });

  it('says how many Environments need the person on their band, counting failed and unconfirmed deploys, never ones at work', () => {
    const bands = deploymentEnvironmentBands([
      row('source-shop', 'storefront', 'Staging', 'danger'),
      row('source-shop', 'storefront', 'Production', 'warning'),
      row('source-shop', 'storefront', 'Preview', null),
      row('source-api', 'payments-api', 'Production', null),
    ]);
    const shop = bands.axis.find((band) => band.key === 'source-shop')!;
    const api = bands.axis.find((band) => band.key === 'source-api')!;
    expect(shop).toMatchObject({ tone: 'danger' });
    expect(shop).toHaveProperty('description');
    expect(api).not.toHaveProperty('description');
    expect(api).not.toHaveProperty('tone');
  });
});
