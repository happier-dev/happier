import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierRowStatusLine } from './RowStatusLine.js';

const host = {
  colors: { quiet: '#555555', warn: '#aa6600', bad: '#aa0000' },
  actionGap: 8,
  renderText: ({ text, numberOfLines }: { text: string; numberOfLines: number }) => <Text numberOfLines={numberOfLines}>{text}</Text>,
  renderBusy: () => <Text testID="busy">Working</Text>,
  renderIndicator: () => <Text testID="indicator">Trouble</Text>,
  renderAction: (action: { label: string; onPress: () => unknown; testID?: string }) => <button data-testid={action.testID} onClick={action.onPress}>{action.label}</button>,
};

describe('compact row status', () => {
  it('keeps healthy words accessible without a trouble indicator or spinner', () => {
    const view = mountThroughReactNativeWeb(<HappierRowStatusLine text="Ready" tone="quiet" testID="status" host={host} />);
    expect(view.container.querySelector('[data-testid="status"]')?.getAttribute('aria-label')).toBe('Ready');
    expect(view.container.textContent).toBe('Ready');
  });

  it('retains the trouble indicator while busy and leaves its recovery action independently operable', () => {
    const onPress = vi.fn();
    const view = mountThroughReactNativeWeb(<HappierRowStatusLine text="Sign in needed" tone="warn" busy numberOfLines={2} testID="status"
      action={{ label: 'Sign in', onPress, testID: 'recover' }} host={host} />);
    expect(view.container.querySelector('[data-testid="busy"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="indicator"]')).not.toBeNull();
    expect(view.container.textContent).toBe('WorkingTroubleSign in neededSign in');
    expect(view.container.querySelector('[data-testid="status"]')?.getAttribute('aria-label')).toBeNull();
    view.container.querySelector<HTMLButtonElement>('[data-testid="recover"]')?.click();
    expect(onPress).toHaveBeenCalledOnce();
  });
});
