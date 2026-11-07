import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { createPermissionActionChip } from './createPermissionActionChip';

async function chipName(showLabel: boolean): Promise<unknown> {
  const screen = await renderScreen(
    <>
      {createPermissionActionChip({
        anchorRef: { current: null },
        tint: '#000',
        showLabel,
        label: 'Accept edits',
        chipStyle: () => ({}),
        textStyle: {},
        onPress: () => {},
      })}
    </>,
  );
  return screen.findByTestId('agent-input-permission-chip')?.props
    .accessibilityLabel;
}

describe('createPermissionActionChip', () => {
  it.each(['', null])('names the permission control while its mode is unavailable (%s)', async label => {
    const screen = await renderScreen(<>{createPermissionActionChip({ anchorRef: { current: null }, tint: '#000',
      showLabel: false, label, chipStyle: () => ({}), textStyle: {}, onPress: () => {} })}</>);
    expect(screen.findByTestId('agent-input-permission-chip')?.props.accessibilityLabel).toBe('Permissions');
  });
  // F-U5-UI live: with chip labels hidden the shield glyph was the whole chip, so keyboard and
  // screen-reader users met an unnamed button in every composer (Session, Run form, opinion).
  it('names the chip by its permission mode when the label is not drawn', async () => {
    expect(await chipName(false)).toBe('Accept edits');
  });

  it('keeps the same name when the label is drawn', async () => {
    expect(await chipName(true)).toBe('Accept edits');
  });
});
