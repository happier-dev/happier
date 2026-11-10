import { UsageMeterRow, UsageMeterStack, type UsageMeterRowProps } from '@happier-dev/plugin-ui/components';

/** The author owns units, localization and reset facts; the public row owns their presentation. */
export function UsageMeterSurface() {
  const rows = [
    { label: 'Weekly', value: '~42% left', remainingPct: 42, valueKnown: true, resetText: 'in 2h', accessibilityLabel: 'Weekly, approximately 42% left, resets in 2h' },
    { label: 'Unknown', value: 'Unavailable', remainingPct: null, valueKnown: false, resetText: 'in 1h', accessibilityLabel: 'Unknown, unavailable, resets in 1h' },
    { label: 'Exhausted', value: '0% left', remainingPct: 0, valueKnown: true, accessibilityLabel: 'Exhausted, 0% left' },
    { label: 'Cost', value: '$1.25', remainingPct: null, valueKnown: true, amount: true, accessibilityLabel: 'Cost, $1.25' },
    { label: 'Requests', value: '320 requests', remainingPct: null, valueKnown: true, amount: true, accessibilityLabel: 'Requests, 320 requests' },
    { label: 'Unknown cost', value: 'Unavailable', remainingPct: null, valueKnown: false, amount: true, accessibilityLabel: 'Unknown cost, unavailable' },
    { label: 'Zero cost', value: '$0.00', remainingPct: null, valueKnown: true, amount: true, accessibilityLabel: 'Zero cost, $0.00' },
  ] satisfies ReadonlyArray<UsageMeterRowProps>;
  return <UsageMeterStack>{rows.map(row => <UsageMeterRow key={row.label} {...row} testID={`meter-${row.label}`} />)}</UsageMeterStack>;
}
