import { describe, expect, it } from 'vitest';

import {
  patchHappierActionInputPath,
  readHappierActionInputPath,
  resolveHappierActionFieldPresentation,
  resolveHappierChoiceControl,
} from './actionInputFields.js';

describe('shared Action form semantics', () => {
  it('draws up to five short ordinal steps as one segmented control and keeps the four-choice cap otherwise', () => {
    const single = { kind: 'select', value: 'medium', multiple: false } as const;
    const levels = (names: readonly string[]) => names.map((label) => ({ label }));
    const five = levels(['Low', 'Medium', 'High', 'XHigh', 'Max']);
    expect.soft(resolveHappierChoiceControl(single, five, { ordinal: true })).toBe('segmented');
    expect.soft(resolveHappierChoiceControl(single, five)).toBe('list');
    expect.soft(resolveHappierChoiceControl(single, levels(['Low', 'Medium', 'High', 'XHigh', 'Max', 'Ultra']), { ordinal: true })).toBe('list');
    expect.soft(resolveHappierChoiceControl(single, levels(['Low', 'Medium', 'High', 'XHigh', 'A much longer step']), { ordinal: true })).toBe('list');
    expect(resolveHappierChoiceControl({ ...single, multiple: true }, five, { ordinal: true })).toBe('list');
  });
  it('keeps an array-valued single choice as one admitted selection', () => {
    const choice = ['source', 'machine'];
    expect(resolveHappierActionFieldPresentation({ widget: 'select' }, choice, choice))
      .toEqual({ kind: 'select', value: choice, multiple: false });
  });
  it('reads and patches nested paths without mutating the source', () => {
    const input = { outer: { keep: true, value: 'old' } };
    expect(readHappierActionInputPath(input, 'outer.value')).toBe('old');
    expect(patchHappierActionInputPath(input, 'outer.value', 'new')).toEqual({
      outer: { keep: true, value: 'new' },
    });
    expect(input.outer.value).toBe('old');
  });

  it('owns widget display and text parsing rules', () => {
    expect(resolveHappierActionFieldPresentation(
      { path: 'items', title: 'Items', widget: 'text_list', listSeparator: 'newline' },
      ['a', 'b'],
    )).toMatchObject({ kind: 'text', value: 'a\nb', multiline: true });
    expect(resolveHappierActionFieldPresentation(
      { path: 'count', title: 'Count', widget: 'integer' },
      2,
    ).parseText?.('')).toBeUndefined();
    expect(resolveHappierActionFieldPresentation(
      { path: 'count', title: 'Count', widget: 'integer' },
      2,
    ).parseText?.('3')).toBe(3);
    expect(resolveHappierActionFieldPresentation(
      { path: 'modes', title: 'Modes', widget: 'multiselect' },
      ['a', 2],
      ['a', '2'],
    )).toEqual({ kind: 'select', value: ['a', '2'], multiple: true });
  });

  it('shows a byte-size integer in GiB and submits bytes, while a field without the unit stays a raw integer', () => {
    const GIB = 1024 ** 3;
    const sized = resolveHappierActionFieldPresentation({ widget: 'integer', unit: 'bytes' }, 4 * GIB);
    expect(sized).toMatchObject({ kind: 'text', value: '4', keyboardType: 'numeric' });
    expect(sized.kind === 'text' && sized.parseText('8')).toBe(8 * GIB);
    expect(sized.kind === 'text' && sized.parseText('')).toBeUndefined();
    // A fractional GiB entry is admitted and lands on whole bytes, so a shown value can be typed back.
    expect(sized.kind === 'text' && sized.parseText('1.5')).toBe(1.5 * GIB);
    expect(sized.kind === 'text' && sized.parseText('0.3')).toBe(Math.round(0.3 * GIB));
    // Partial or inadmissible entry stays as typed text and is shown as typed.
    expect(sized.kind === 'text' && sized.parseText('1.')).toBe('1.');
    expect(sized.kind === 'text' && sized.parseText('4G')).toBe('4G');
    expect(resolveHappierActionFieldPresentation({ widget: 'integer', unit: 'bytes' }, '1.')).toMatchObject({ value: '1.' });
    // A stored value that is not a whole GiB is shown exactly, never rounded.
    expect(resolveHappierActionFieldPresentation({ widget: 'integer', unit: 'bytes' }, GIB * 1.5)).toMatchObject({ value: '1.5' });
    const raw = resolveHappierActionFieldPresentation({ widget: 'integer' }, 4 * GIB);
    expect(raw).toMatchObject({ value: String(4 * GIB) });
    expect(raw.kind === 'text' && raw.parseText('8')).toBe(8);
  });

  it('preserves incomplete numeric edits until they become admissible finite numbers', () => {
    const integer = resolveHappierActionFieldPresentation(
      { widget: 'integer' },
      undefined,
    );
    const number = resolveHappierActionFieldPresentation(
      { widget: 'number' },
      undefined,
    );

    expect(integer.parseText?.('-')).toBe('-');
    expect(integer.parseText?.('-5')).toBe(-5);
    expect(integer.parseText?.('1.5')).toBe('1.5');
    expect(number.parseText?.('1.')).toBe('1.');
    expect(number.parseText?.('1.5')).toBe(1.5);
    expect(number.parseText?.('1e')).toBe('1e');
    expect(number.parseText?.('1e2')).toBe(100);
    expect(number.parseText?.('Infinity')).toBe('Infinity');
    expect(number.parseText?.('')).toBeUndefined();
  });

  it('consumes host-normalized Connected Account option values without parsing raw refs', () => {
    const account = {
      service: { pluginId: 'com.acme.accounts', localId: 'service' },
      accountId: 'account-1',
    };
    const malformed = {
      service: { pluginId: 'com.acme.accounts', localId: 'service' },
      accountId: '',
    };

    expect(resolveHappierActionFieldPresentation(
      { path: 'credentialRef', title: 'Account', widget: 'select' },
      { ...account, service: { ...account.service } },
      undefined,
    )).toEqual({ kind: 'select', value: undefined, multiple: false });
    expect(resolveHappierActionFieldPresentation(
      { path: 'credentialRef', title: 'Account', widget: 'select' },
      malformed,
      account,
    )).toEqual({ kind: 'select', value: account, multiple: false });
    expect(resolveHappierActionFieldPresentation(
      { path: 'credentialRefs', title: 'Accounts', widget: 'multiselect' },
      [{ ...account, service: { ...account.service } }],
      [],
    )).toEqual({ kind: 'select', value: [], multiple: true });
    expect(resolveHappierActionFieldPresentation(
      { path: 'credentialRefs', title: 'Accounts', widget: 'multiselect' },
      [malformed],
      [account],
    )).toEqual({ kind: 'select', value: [account], multiple: true });
  });
});
