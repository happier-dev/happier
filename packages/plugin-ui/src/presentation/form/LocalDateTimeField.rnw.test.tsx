import { act, useState } from 'react';
import { Text } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { resetHappierPrimaryPointerForTesting } from '../../environment/interactiveTarget.js';
import { readHitAreaReach } from '../interaction/hitArea.testSupport.js';
import {
  HappierLocalDateTimeField,
  type HappierLocalDateTimePickerHost,
  type HappierLocalDateTimePickerRequest,
} from './LocalDateTimeField.js';
import type { HappierLocalDateTimeDraft } from './localDateTimeValue.js';

const NOW = new Date(2026, 8, 9, 12, 0).getTime();
const LABELS = {
  date: 'Date',
  time: 'Time',
  pastInstant: 'Choose a time in the future',
};

function Harness(
  props: Readonly<{
    picker?: HappierLocalDateTimePickerHost;
    initial?: HappierLocalDateTimeDraft;
  }>,
) {
  const [value, setValue] = useState<HappierLocalDateTimeDraft>(
    props.initial ?? { date: '2026-09-10', time: '09:25' },
  );
  return (
    <HappierLocalDateTimeField
      nowMs={NOW}
      value={value}
      onChange={setValue}
      labels={LABELS}
      testIDPrefix="lease"
      theme={createSurfaceContext().theme}
      {...(props.picker ? { picker: props.picker } : {})}
    />
  );
}

const query = (
  view: ReturnType<typeof mountThroughReactNativeWeb>,
  testID: string,
) => view.container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

afterEach(() => {
  vi.unstubAllGlobals();
  resetHappierPrimaryPointerForTesting();
});

describe('local date-time field', () => {
  it('keeps a finger on the picker button out of the text it shares the field with', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' || query === '(hover: none)' }));
    resetHappierPrimaryPointerForTesting();
    const picker: HappierLocalDateTimePickerHost = { renderGlyph: (mode) => <Text>{mode}</Text>, renderPicker: () => null };
    const view = mountThroughReactNativeWeb(<Harness picker={picker} />);
    expect(readHitAreaReach(query(view, 'lease-date-picker-button')!)?.left).toBe(0);
  });

  it('is typed alone when the host has no picker, and says when the reading is not in the future', () => {
    const view = mountThroughReactNativeWeb(
      <Harness initial={{ date: '2026-09-01', time: '09:00' }} />,
    );
    expect(query(view, 'lease-date-input')).not.toBeNull();
    expect(query(view, 'lease-time-input')).not.toBeNull();
    expect(query(view, 'lease-date-picker-button')).toBeNull();
    expect(query(view, 'lease-past-instant')?.textContent).toBe(
      'Choose a time in the future',
    );
  });

  it("opens the host's picker from each field's own button, from today onward, and writes the picked part back", () => {
    let request: HappierLocalDateTimePickerRequest | null = null;
    const picker: HappierLocalDateTimePickerHost = {
      renderGlyph: (mode) => <Text>{mode}</Text>,
      renderPicker: vi.fn((next: HappierLocalDateTimePickerRequest) => {
        request = next;
        return <Text testID={`picker:${next.mode}`}>{next.mode}</Text>;
      }),
    };
    const view = mountThroughReactNativeWeb(<Harness picker={picker} />);
    const dateButton = query(view, 'lease-date-picker-button')!;
    expect(dateButton.getAttribute('role')).toBe('button');
    expect(dateButton.getAttribute('aria-label')).toBe('Date');
    expect(query(view, 'picker:date')).toBeNull();

    act(() => {
      dateButton.click();
    });
    expect(query(view, 'picker:date')).not.toBeNull();
    expect(request!.minimumDate.getTime()).toBe(NOW);
    expect(request!.value.getTime()).toBe(
      new Date(2026, 8, 10, 9, 25).getTime(),
    );

    act(() => {
      request!.onChange(new Date(2026, 9, 3, 18, 40));
    });
    expect((query(view, 'lease-date-input') as HTMLInputElement).value).toBe(
      '2026-10-03',
    );
    // Picking a day leaves the typed time alone.
    expect((query(view, 'lease-time-input') as HTMLInputElement).value).toBe(
      '09:25',
    );

    act(() => {
      request!.onDismiss();
    });
    expect(query(view, 'picker:date')).toBeNull();

    act(() => {
      query(view, 'lease-time-picker-button')!.click();
    });
    act(() => {
      request!.onChange(new Date(2026, 9, 3, 18, 40));
    });
    expect((query(view, 'lease-time-input') as HTMLInputElement).value).toBe(
      '18:40',
    );
  });
});
