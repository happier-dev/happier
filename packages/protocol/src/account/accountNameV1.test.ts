import { describe, expect, it } from 'vitest';
import { classifyAccountActorLabelV1, resolveAccountDisplayLabelV1, projectAccountNameToLegacyFieldsV1, readAccountNameFromLegacyProfileV1 } from './accountDisplayProfileV1.js';
import { AccountNameUpdateRequestV1Schema } from './profile.js';

describe('Account name', () => {
  it('normalizes one freely chosen name and clears empty input without admitting another Account', () => {
    expect(AccountNameUpdateRequestV1Schema.parse({ name: '  Leeroy Brun  ' })).toEqual({ name: 'Leeroy Brun' });
    expect(AccountNameUpdateRequestV1Schema.parse({ name: '  ' })).toEqual({ name: null });
    expect(AccountNameUpdateRequestV1Schema.parse({ name: null })).toEqual({ name: null });
    expect(AccountNameUpdateRequestV1Schema.safeParse({ name: 'Leeroy', accountId: 'other' }).success).toBe(false);
    expect(AccountNameUpdateRequestV1Schema.parse({ name: 'x'.repeat(10000) }).name).toHaveLength(10000);
  });

  it('uses the chosen name before username and never invents a label from an Account id', () => {
    expect(resolveAccountDisplayLabelV1({ name: '  Captain  ', username: 'leeroybrun' })).toBe('Captain');
    expect(resolveAccountDisplayLabelV1({ name: ' ', username: ' leeroybrun ' })).toBe('leeroybrun');
    expect(resolveAccountDisplayLabelV1({ name: null, username: null })).toBeNull();
  });

  it('classifies self, current profile, former relationship and unnamed actors before localization', () => {
    const named = { accessibility: 'current' as const, profile: { name: '  Captain  ', username: 'leeroybrun' } };
    expect(classifyAccountActorLabelV1(named, false)).toEqual({ kind: 'profile', label: 'Captain', source: 'name' });
    expect(classifyAccountActorLabelV1(named, true)).toEqual({ kind: 'self' });
    expect(classifyAccountActorLabelV1({ ...named, accessibility: 'former' }, true)).toEqual({ kind: 'former' });
    expect(classifyAccountActorLabelV1({ accessibility: undefined, profile: null }, false)).toEqual({ kind: 'former' });
    expect(classifyAccountActorLabelV1({ accessibility: 'current', profile: null }, false)).toEqual({ kind: 'unnamed' });
  });

  it('keeps an unsplit name visible to legacy first/last readers', () => {
    expect(projectAccountNameToLegacyFieldsV1('  Leeroy Brun  ')).toEqual({ firstName: 'Leeroy Brun', lastName: null });
    expect(projectAccountNameToLegacyFieldsV1('Leeroy')).toEqual({ firstName: 'Leeroy', lastName: null });
    expect(projectAccountNameToLegacyFieldsV1(null)).toEqual({ firstName: null, lastName: null });
    expect(readAccountNameFromLegacyProfileV1({ firstName: 'Leeroy', lastName: 'Brun' })).toBe('Leeroy Brun');
    expect(readAccountNameFromLegacyProfileV1({ name: null, firstName: 'Old', lastName: 'Name' })).toBeNull();
  });
});
