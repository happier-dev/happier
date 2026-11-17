import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(standardCleanup);

const { createApprovalProfileComposerChip } = await import('./createApprovalProfileComposerChip');
const profiles = [{ id: 'custom:careful', name: 'Careful agent' }];
const ctx = { chipStyle: () => ({}), iconColor: '#000', showLabel: true, textStyle: {}, countTextStyle: {} } as never;

// UI refinements 21:36Z (F3): the approval profile is one chip of the composer's chip row, naming its field until a
// profile is chosen; its menu holds the same choices as the field (one choice list, ApprovalProfileSelect's).
it('names its field in the chip row until a profile is chosen, and offers the same choices', async () => {
  const chip = createApprovalProfileComposerChip({ value: undefined, profiles, machineDefault: { profile: null }, ready: true, onChange: () => {} });
  expect(chip.controlId).toBe('approvalProfile');
  const popover = chip.collapsedOptionsPopover!;
  expect(popover.presentation).toBe('list');
  const ids = popover.presentation === 'list' ? popover.rootStep.sections.flatMap(section => 'options' in section ? section.options.map(option => option.id) : []) : [];
  expect(ids).toEqual(['machine_default', 'custom:careful']);
  const screen = await renderScreen(<>{chip.render(ctx)}</>);
  expect(screen.getTextContent()).toMatch(/workflows\.triggers\.guided\.profile\.title|Approval profile/);
  expect(screen.getTextContent()).not.toMatch(/machineDefault|Machine default/);
});

it('shows the chosen profile on the chip', async () => {
  const chip = createApprovalProfileComposerChip({ value: 'custom:careful', profiles, machineDefault: null, ready: true, onChange: () => {} });
  const screen = await renderScreen(<>{chip.render(ctx)}</>);
  expect(screen.getTextContent()).toMatch(/Careful agent/);
});

it('shows a confirmed missing selection while the unopened catalog remains cold', async () => {
  const chip = createApprovalProfileComposerChip({ value: 'removed-profile', profiles: [], machineDefault: null,
    ready: false, displayReady: true, onChange: () => {} });
  const screen = await renderScreen(<>{chip.render(ctx)}</>);
  expect(screen.getTextContent()).toMatch(/deletedName|Deleted profile/);
});

// Mockup "Machine default · Careful agent": a new Session that follows a Machine with a profile names that profile.
it('names the Machine default profile while the Session follows it', async () => {
  const chip = createApprovalProfileComposerChip({ value: null, profiles, machineDefault: { profile: profiles[0]! }, ready: true, onChange: () => {} });
  const screen = await renderScreen(<>{chip.render(ctx)}</>);
  expect(screen.getTextContent()).toMatch(/Careful agent/);
});
