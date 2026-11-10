import * as React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

describe('PileBar on a phone page', () => {
  const previousOS = Platform.OS;
  afterEach(() => { Reflect.set(Platform, 'OS', previousOS); standardCleanup(); });

  it('docks above the floating tab bar so its Review stays tappable', async () => {
    Reflect.set(Platform, 'OS', 'web');
    const { PileBar } = await import('./PileBar');
    const { SessionCockpitBottomChromeHeightContext } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
    const screen = await renderScreen(
      <SessionCockpitBottomChromeHeightContext.Provider value={84}>
        <PileBar bar={{ kind: 'ready', count: 2, freesBytes: 2_000_000 }} note={null} compact onReview={() => {}} testID="pile" />
      </SessionCockpitBottomChromeHeightContext.Provider>,
    );
    const dock = screen.tree.findAll(node => typeof node.props.style !== 'undefined'
      && StyleSheet.flatten(node.props.style)?.position === 'sticky')[0];
    expect(Number(StyleSheet.flatten(dock?.props.style)?.bottom)).toBeGreaterThanOrEqual(84);
    await screen.unmount();
    // Its first import builds the storage page's module graph; a cold worker can need more than the default.
  }, 180_000);
});
