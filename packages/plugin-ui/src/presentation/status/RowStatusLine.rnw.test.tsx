import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierRowStatusLine } from './RowStatusLine.js';

const host = {
  colors: { quiet: '#555555', warn: '#aa6600', bad: '#aa0000' },
  actionGap: 8,
  renderText: ({ text, numberOfLines, mono }: { text: string; numberOfLines: number; mono?: boolean }) =>
    <Text numberOfLines={numberOfLines} testID={mono ? 'mono' : undefined}>{text}</Text>,
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

  it('leads with a quiet mono command and keeps the outcome whole, without a dot when the row mark already says it', () => {
    const view = mountThroughReactNativeWeb(<HappierRowStatusLine lead="yarn lint" text="Exited with code 1 at 10:12" tone="bad" marked
      testID="status" host={host} />);
    expect(view.container.querySelector('[data-testid="mono"]')?.textContent).toBe('yarn lint');
    expect(view.container.querySelector('[data-testid="indicator"]')).toBeNull();
    expect(view.container.textContent).toBe('yarn lint · Exited with code 1 at 10:12');
    expect(view.container.querySelector('[data-testid="status"]')?.getAttribute('aria-label')).toBe('yarn lint · Exited with code 1 at 10:12');
  });

  it('says where the subject comes from between the command and the outcome, in the quiet tone even when the outcome failed', () => {
    const tones: Array<[string, string]> = [];
    const recording = { ...host, renderText: (input: { text: string; numberOfLines: number; mono?: boolean; style: { color: string } }) => {
      tones.push([input.text, input.style.color]);
      return host.renderText(input);
    } };
    const view = mountThroughReactNativeWeb(<HappierRowStatusLine lead="yarn lint --fix" context="changed just for you"
      text="Exited with code 1" tone="bad" marked testID="status" host={recording} />);
    expect(view.container.querySelector('[data-testid="status"]')?.getAttribute('aria-label'))
      .toBe('yarn lint --fix · changed just for you · Exited with code 1');
    expect(tones.find(([text]) => text === 'changed just for you')?.[1]).toBe(host.colors.quiet);
    expect(tones.find(([text]) => text === 'Exited with code 1')?.[1]).toBe(host.colors.bad);
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
