import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { OfferedChoicesSurface } from '../../../fixtures/external-authoring/src/offeredChoicesSurface.js';
import { HappierUiEnvironmentProvider, projectHappierUiEnvironment } from '../../environment/index.public.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContextFixture } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { OfferedChoices } from '../index.public.js';

it('opens the default feedback field with only the explicit presentation theme', () => {
  const mount = mountThroughReactNativeWeb(<OfferedChoices theme={createSurfaceContextFixture().theme}
    choices={[{ id: 'changes', label: 'Request changes', refusal: true, available: true, allowsFeedback: true }]}
    primaryId={null} disabled={false} busyChoiceId={null} unavailableReason="Ask the owner"
    feedbackPlaceholder="What should change?" cancelLabel="Cancel" onChoose={() => {}} testID="explicit" />);
  try {
    act(() => mount.container.querySelector<HTMLElement>('[data-testid="explicit.choice.changes"]')!.click());
    expect(mount.container.querySelector('[data-testid="explicit.feedback"]')?.getAttribute('aria-label')).toBe('Request changes');
  } finally { mount.unmount(); }
});

it('gives a listed choice a second line only when it says something its label does not', () => {
  const mount = mountThroughReactNativeWeb(<OfferedChoices theme={createSurfaceContextFixture().theme}
    choices={[
      { id: 'remember', label: 'Always allow in this workspace: touch …', description: 'Always allow in this workspace: touch …', refusal: false, available: true },
      { id: 'once', label: 'Allow once', description: 'Runs it this time only', refusal: false, available: true },
      { id: 'reject', label: 'Reject', description: ' Reject ', refusal: true, available: true },
    ]}
    primaryId="once" disabled={false} busyChoiceId={null} unavailableReason="Ask the owner"
    feedbackPlaceholder="What should change?" cancelLabel="Cancel" onChoose={() => {}} testID="described" />);
  try {
    const text = (id: string) => mount.container.querySelector(`[data-testid="described.choice.${id}"]`)?.textContent;
    expect(text('remember')).toBe('Always allow in this workspace: touch …');
    expect(text('once')).toBe('Allow onceRuns it this time only');
    expect(text('reject')).toBe('Reject');
  } finally { mount.unmount(); }
});

it('lets a public author preserve agent order, withheld scope explanations and optional feedback', () => {
  const onChoose = vi.fn();
  const mount = mountThroughReactNativeWeb(<HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContextFixture())}><OfferedChoicesSurface onChoose={onChoose} /></HappierUiEnvironmentProvider>);
  const control = (id: string) => mount.container.querySelector<HTMLElement>(`[data-testid="offered.${id}"]`)!;
  try {
    expect(Array.from(mount.container.querySelectorAll('[data-testid^="offered.choice."]')).map(node => node.textContent)).toEqual([
      'Allow this sessionUntil this session ends', 'Allow once', 'Save a ruleAsk the owner', 'Request changes',
    ]);
    expect(control('choice.owner').getAttribute('aria-disabled')).toBe('true');
    act(() => control('choice.owner').click());
    expect(onChoose).not.toHaveBeenCalled();
    act(() => control('choice.reject').click());
    expect(control('feedback').getAttribute('aria-label')).toBe('Request changes');
    act(() => control('feedback.cancel').click());
    expect(control('choice.reject')).not.toBeNull();
    act(() => control('choice.once').click());
    expect(onChoose).toHaveBeenCalledWith('once');
    act(() => control('choice.reject').click());
    act(() => control('feedback.send').click());
    expect(onChoose).toHaveBeenLastCalledWith('reject', undefined);
    expect(control('choice.reject')).not.toBeNull();
  } finally { mount.unmount(); }
});
