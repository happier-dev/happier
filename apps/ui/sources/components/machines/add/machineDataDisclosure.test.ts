import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { machineDataDisclosure } from './machineDataDisclosure';

describe('Add a machine → What leaves this Machine (lab dConnect #2)', () => {
  it('says what only your devices can read on an end-to-end encrypted Account', () => {
    const disclosure = machineDataDisclosure('e2ee')!;
    expect(disclosure.description).toBe(
      t('machineDataDisclosure.e2eeDescription'),
    );
    expect(disclosure.rows.map((row) => row.id)).toEqual([
      'daemonSends',
      'devicesRead',
      'serverReads',
    ]);
    expect(
      disclosure.rows.find((row) => row.id === 'serverReads')?.detail,
    ).toBe(t('machineDataDisclosure.serverReadsE2ee'));
  });

  it('says the Home can read Machine details and Session content on a plain Account, with no devices-only row', () => {
    const disclosure = machineDataDisclosure('plain')!;
    expect(disclosure.description).toBe(
      t('machineDataDisclosure.plainDescription'),
    );
    expect(disclosure.rows.map((row) => row.id)).toEqual([
      'daemonSends',
      'serverReads',
    ]);
    expect(
      disclosure.rows.find((row) => row.id === 'serverReads')?.detail,
    ).toBe(t('machineDataDisclosure.serverReadsPlain'));
  });

  it("claims nothing while the Account's mode is unknown", () => {
    expect(machineDataDisclosure(null)).toBeNull();
  });
});
