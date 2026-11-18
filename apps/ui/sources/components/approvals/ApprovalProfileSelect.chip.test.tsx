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
        mode="session"
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
      /machineDefault|Machine default/,
    );
  },
);

it('shows the chosen profile on the composer chip', async () => {
  const screen = await renderScreen(
    <ApprovalProfileSelect
      mode="session"
      presentation="chips"
      testID="profile"
      value="custom:careful"
      source={{
        ...source,
        profiles: [{ id: 'custom:careful', name: 'Careful agent' }],
      }}
      onChange={() => {}}
    />,
  );
  expect(screen.getTextContent()).toMatch(/Careful agent/);
});

it('announces a chip that names its own field once, not "Approval profile: Approval profile"', async () => {
  const screen = await renderScreen(<ApprovalProfileSelect mode="session" presentation="chips" testID="profile"
    value={undefined} source={source} onChange={() => {}} />);
  const label = screen.findByTestId('profile-chip')?.props.accessibilityLabel ?? screen.findByTestId('profile-chip')?.props['aria-label'];
  expect(label).toMatch(/^(workflows\.triggers\.guided\.profile\.title|Approval profile)$/);
});

// A workflow step's unset profile inherits the workflow's, which is the Machine's default: the quiet chip says that value
// (WF-ACCEPT-1118 item 7, lab round 1116b), unlike the composer's empty field above.
it('names the inherited Machine default on a quiet chip where an unset value inherits', async () => {
  const screen = await renderScreen(
    <ApprovalProfileSelect
      mode="session"
      presentation="chips"
      testID="profile"
      value={undefined}
      inherited
      source={source}
      onChange={() => {}}
    />,
  );
  const text = screen.getTextContent();
  expect(text).toMatch(/workflows\.triggers\.guided\.profile\.machineDefault|Machine default/);
  expect(text).not.toMatch(/workflows\.triggers\.guided\.profile\.title/);
});
