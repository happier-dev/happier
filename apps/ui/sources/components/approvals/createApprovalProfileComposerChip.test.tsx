import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(standardCleanup);

const { createApprovalProfileComposerChip } = await import('./createApprovalProfileComposerChip');
const profiles = [{ id: 'builtin:apply-safe', name: 'Apply safe actions', defaultMode: 'allow' }] as never;
const ctx = { chipStyle: () => ({}), iconColor: '#000', showLabel: true, textStyle: {}, countTextStyle: {} } as never;

// UI refinements 21:36Z (F3): the approval profile is one chip of the composer's chip row, naming its field until a
// profile is chosen; its menu holds the same choices as the field (one choice list, ApprovalProfileSelect's).
it('names its field in the chip row until a profile is chosen, and offers the same choices', async () => {
  const chip = createApprovalProfileComposerChip({ value: undefined, profiles, ready: true, onChange: () => {} });
  expect(chip.controlId).toBe('approvalProfile');
  const popover = chip.collapsedOptionsPopover!;
  expect(popover.presentation).toBe('list');
  const ids = popover.presentation === 'list' ? popover.rootStep.sections.flatMap(section => 'options' in section ? section.options.map(option => option.id) : []) : [];
  expect(ids).toContain('builtin:apply-safe');
  const screen = await renderScreen(<>{chip.render(ctx)}</>);
  expect(screen.getTextContent()).toMatch(/workflows\.triggers\.guided\.profile\.title|Approval profile/);
  expect(screen.getTextContent()).not.toMatch(/inheritSessionProfile|Inherit the Session profile/);
});

it('shows the chosen profile on the chip', async () => {
  const chip = createApprovalProfileComposerChip({ value: 'builtin:apply-safe', profiles, ready: true, onChange: () => {} });
  const screen = await renderScreen(<>{chip.render(ctx)}</>);
  expect(screen.getTextContent()).toMatch(/Apply safe actions|applySafeName/);
});
