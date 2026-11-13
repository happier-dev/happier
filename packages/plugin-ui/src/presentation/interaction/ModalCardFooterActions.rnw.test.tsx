import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierModalCardFooterActions } from './ModalCardFooterActions.js';

function actionsDirection(count: number): string {
  const view = mountThroughReactNativeWeb(<HappierModalCardFooterActions phoneSheet gap={8}>
    {Array.from({ length: count }, (_, index) => <View key={index} testID={`action-${index}`} />)}
    {null}
  </HappierModalCardFooterActions>);
  const row = view.container.querySelector<HTMLElement>('[data-testid="action-0"]')!.parentElement!.parentElement!;
  return getComputedStyle(row).flexDirection;
}

describe('HappierModalCardFooterActions on a phone sheet', () => {
  // SOS-SURFACES-1112 / FIX-RERUN-1113: three full-width actions in one phone row clip their labels ("Initialize rep…").
  it('keeps two actions side by side and stacks three, each at the sheet width', () => {
    expect(actionsDirection(2)).toBe('row');
    expect(actionsDirection(3)).toBe('column');
  });
});
