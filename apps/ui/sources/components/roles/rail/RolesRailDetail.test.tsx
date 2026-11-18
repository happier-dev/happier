/**
 * The Roles detail of the engine popover says which role and model are in use as "Uses {role} · {model}",
 * never "Effective:" (07 §2.3 item 18).
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

const { RolesRailDetailView } = await import('./RolesRailDetail');

describe('RolesRailDetailView', () => {
  it('says the chosen role and its model as "Uses", not "Effective:"', async () => {
    const screen = await renderScreen(
      <RolesRailDetailView
        value="builder"
        onChange={() => {}}
        roles={[
          {
            roleId: 'builder',
            name: 'Builder',
            purpose: 'Makes the change',
            engineLabel: 'Opus 5.5 · High',
          },
          { roleId: 'reviewer', name: 'Reviewer', purpose: 'Reviews a change' },
        ]}
      />,
    );
    const texts = screen
      .findAll((node) => typeof node.children?.[0] === 'string')
      .map((node) => String(node.children[0]));
    expect(texts).toContain(
      t('roles.rail.uses', { label: 'Builder ·\u00A0Opus 5.5 · High' }),
    );
    expect(texts.some((text) => text.startsWith('Effective'))).toBe(false);
    await screen.unmount();
  });
});
