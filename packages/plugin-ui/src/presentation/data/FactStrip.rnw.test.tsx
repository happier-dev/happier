import { expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierFactStrip, type HappierFactStripTextProps } from './FactStrip.js';

function RoleText(props: HappierFactStripTextProps) {
  return <span data-role={props.role}>{props.children}</span>;
}

const facts = [
  { key: 'status', label: 'Status', value: 'Ready', detail: 'into main' },
  { key: 'checks', label: 'Checks', value: '2 failing', detail: 'Vercel' },
  { key: 'reviewers', label: 'Reviewers', value: 'Waiting on you' },
];

it('holds a quiet line for a late detail side by side, and on a phone ends no card on an empty band', () => {
  const wide = mountThroughReactNativeWeb(<HappierFactStrip facts={facts} Text={RoleText} ruleColor="#ccc" layout="columns" divided reserveDetail />);
  const phone = mountThroughReactNativeWeb(<HappierFactStrip facts={facts} Text={RoleText} ruleColor="#ccc" layout="columns" divided reserveDetail narrow />);
  try {
    expect(wide.container.querySelectorAll('[data-role="detail"]')).toHaveLength(3);
    expect(phone.container.querySelectorAll('[data-role="detail"]')).toHaveLength(2);
  } finally { wide.unmount(); phone.unmount(); }
});
