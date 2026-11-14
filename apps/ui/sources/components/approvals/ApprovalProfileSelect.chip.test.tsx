import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ApprovalProfileSelect } from './ApprovalProfileSelect';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

afterEach(standardCleanup);

const source = {
  profiles: [],
  selection: null,
  ready: true,
  unavailable: false,
} as const;

// A composer chip with nothing chosen names its field ("Approval profile"), the filter-chip convention; it never shows a
// sentence about inheriting from a Session a fresh draft doesn't have (QA-SHELL-1114 F3: Home showed "Inherit the
// Session profile" as a full-width bar above every new Session).
it.each([undefined, null])(
  'names the field on the composer chip while no profile is chosen (%s)',
  async (value) => {
    const screen = await renderScreen(
      <ApprovalProfileSelect
        mode="authoring"
        presentation="chips"
        testID="profile"
        value={value}
        source={source}
        onChange={() => {}}
      />,
    );
    const text = screen.getTextContent();
    expect(text).toMatch(
      /workflows\.triggers\.guided\.profile\.title|Approval profile/,
    );
    expect(text).not.toMatch(
      /inheritSessionProfile|noExplicitSessionProfile|Inherit the Session profile|No explicit Session profile/,
    );
  },
);

it('shows the chosen profile on the composer chip', async () => {
  const screen = await renderScreen(
    <ApprovalProfileSelect
      mode="authoring"
      presentation="chips"
      testID="profile"
      value="builtin:apply-safe"
      source={{
        ...source,
        profiles: [
          {
            id: 'builtin:apply-safe',
            name: 'Apply safe actions',
            defaultMode: 'allow',
          },
        ] as never,
      }}
      onChange={() => {}}
    />,
  );
  expect(screen.getTextContent()).toMatch(/Apply safe actions|applySafeName/);
});

it('announces a chip that names its own field once, not "Approval profile: Approval profile"', async () => {
  const screen = await renderScreen(<ApprovalProfileSelect mode="authoring" presentation="chips" testID="profile"
    value={undefined} source={source} onChange={() => {}} />);
  const label = screen.findByTestId('profile-chip')?.props.accessibilityLabel ?? screen.findByTestId('profile-chip')?.props['aria-label'];
  expect(label).toMatch(/^(workflows\.triggers\.guided\.profile\.title|Approval profile)$/);
});
