import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierDecisionBar, type HappierDecisionButtonProps } from './DecisionBar.js';

// This host is a platform control boundary. The bar's ordering and admission stay real.
function Button(props: HappierDecisionButtonProps) {
  return <button data-testid={props.testID} data-emphasis={props.emphasis}
    disabled={props.disabled} aria-busy={props.busy} onClick={() => props.onPress()}>{props.label}</button>;
}

describe('HappierDecisionBar', () => {
  it('offers one primary approval, secondary rejection and neutral optional dismissal in reading order', () => {
    const approve = vi.fn(); const reject = vi.fn(); const dismiss = vi.fn();
    const mounted = mountThroughReactNativeWeb(<HappierDecisionBar Button={Button}
      approve={{ label: 'Approve', testID: 'approve', onPress: approve }}
      reject={{ label: 'Reject', testID: 'reject', onPress: reject }}
      dismiss={{ label: 'Dismiss', testID: 'dismiss', onPress: dismiss }} />);
    try {
      const buttons = Array.from(mounted.container.querySelectorAll('button'));
      expect(buttons.map(button => button.dataset.testid)).toEqual(['approve', 'dismiss', 'reject']);
      expect(buttons.map(button => button.dataset.emphasis)).toEqual(['primary', 'plain', 'secondary']);
      act(() => { buttons.forEach(button => button.click()); });
      expect(approve).toHaveBeenCalledOnce(); expect(reject).toHaveBeenCalledOnce(); expect(dismiss).toHaveBeenCalledOnce();
    } finally { mounted.unmount(); }
  });

  it('keeps rejection and dismissal available when only approval is withheld', () => {
    const approve = vi.fn(); const reject = vi.fn(); const dismiss = vi.fn();
    const mounted = mountThroughReactNativeWeb(<HappierDecisionBar Button={Button}
      approve={{ label: 'Approve', onPress: approve, disabled: true }}
      reject={{ label: 'Reject', onPress: reject }} dismiss={{ label: 'Dismiss', onPress: dismiss }} />);
    try {
      const buttons = Array.from(mounted.container.querySelectorAll('button'));
      expect(buttons.map(button => button.disabled)).toEqual([true, false, false]);
      act(() => { buttons.forEach(button => button.click()); });
      expect(approve).not.toHaveBeenCalled(); expect(reject).toHaveBeenCalledOnce(); expect(dismiss).toHaveBeenCalledOnce();
    } finally { mounted.unmount(); }
  });

  it.each(['disabled', 'busy'] as const)('prevents every decision while %s', state => {
    const decide = vi.fn();
    const mounted = mountThroughReactNativeWeb(<HappierDecisionBar Button={Button} {...{ [state]: true }}
      approve={{ label: 'Approve', onPress: decide }} reject={{ label: 'Reject', onPress: decide }}
      dismiss={{ label: 'Dismiss', onPress: decide }} />);
    try {
      const buttons = Array.from(mounted.container.querySelectorAll('button'));
      expect(buttons).toHaveLength(3);
      expect(buttons.every(button => button.disabled)).toBe(true);
      act(() => { buttons.forEach(button => button.click()); });
      expect(decide).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it('makes an in-flight action busy and prevents competing answers without inventing dismissal', () => {
    const decide = vi.fn();
    const mounted = mountThroughReactNativeWeb(<HappierDecisionBar Button={Button}
      approve={{ label: 'Approve', onPress: decide, busy: true }} reject={{ label: 'Reject', onPress: decide }} />);
    try {
      const buttons = Array.from(mounted.container.querySelectorAll('button'));
      expect(buttons).toHaveLength(2);
      expect(buttons.map(button => button.disabled)).toEqual([true, true]);
      expect(buttons[0]!.getAttribute('aria-busy')).toBe('true');
      act(() => { buttons.forEach(button => button.click()); });
      expect(decide).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });
});
