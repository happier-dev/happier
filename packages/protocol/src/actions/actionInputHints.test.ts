import { describe, expect, it } from 'vitest';

import { ActionInputHintsSchema } from './actionInputHints.js';

describe('Action input hint path grammar', () => {
  it('admits an explicitly host-resolved empty Connected Account field without relaxing static selects', () => {
    const hostResolvedEmpty = ActionInputHintsSchema.safeParse({
      fields: [{
        path: 'credentialRef',
        title: 'Connected account',
        widget: 'select',
        options: [],
        resolvedEmptyConnectedAccountOptions: true,
      }],
    });
    const staticEmpty = ActionInputHintsSchema.safeParse({
      fields: [{
        path: 'credentialRef',
        title: 'Connected account',
        widget: 'select',
        options: [],
      }],
    });

    expect(hostResolvedEmpty.success).toBe(true);
    expect(staticEmpty.success).toBe(false);
  });

  it('rejects segment-local whitespace before secret cleanup and max-selection consumers see a descriptor', () => {
    const parsed = ActionInputHintsSchema.safeParse({
      fields: [{
        path: 'auth. token',
        title: 'Token',
        widget: 'secret',
      }, {
        path: 'preferences. selections',
        title: 'Selections',
        widget: 'multiselect',
        maxSelections: 1,
        options: [
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ],
      }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['fields', 0, 'path'] }),
      expect.objectContaining({ path: ['fields', 1, 'path'] }),
    ]));
  });

  it('rejects a whitespace-segment predicate instead of letting it read a secret path', () => {
    const parsed = ActionInputHintsSchema.safeParse({
      fields: [{
        path: 'auth.token',
        title: 'Token',
        widget: 'secret',
      }, {
        path: 'followUp',
        title: 'Follow up',
        widget: 'text',
        visibleWhen: { op: 'truthy', path: 'auth. token' },
      }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['fields', 1, 'visibleWhen', 'path'] }),
    ]));
  });
});
