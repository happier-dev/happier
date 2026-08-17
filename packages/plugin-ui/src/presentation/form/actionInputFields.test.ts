import { describe, expect, it } from 'vitest';

import {
  patchHappierActionInputPath,
  readHappierActionInputPath,
  resolveHappierActionFieldPresentation,
} from './actionInputFields.js';

describe('shared Action form semantics', () => {
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
