import { describe, expect, it } from 'vitest';
import { act } from 'react';

import { FollowPolicyEditorExample } from '../../fixtures/external-authoring/src/followPolicyEditorSurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { FollowPolicyEditor, type FollowPolicyEditorReceiver } from './FollowPolicyEditor.js';
import { PluginUiProvider } from './PluginUiProvider.js';

const EVENTS = [
  { id: 'needs_you.decision', delivery: 'interrupt' },
  { id: 'needs_you.approval', delivery: 'interrupt' },
  { id: 'needs_you.blocked', delivery: 'interrupt' },
  { id: 'finished', delivery: 'quiet' },
  { id: 'message', delivery: 'off' },
] as const;

function mountEditor(preset: string, receiver?: FollowPolicyEditorReceiver) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <FollowPolicyEditor
        {...(receiver === undefined ? {} : { receiver })}
        preset={preset}
        presets={['everything', 'important', 'quiet', 'custom']}
        events={EVENTS}
        onSelectPreset={() => undefined}
        onSetDelivery={() => undefined}
      />
    </PluginUiProvider>,
  );
}

describe('FollowPolicyEditor receiver', () => {
  it('names the channels for a person unless told otherwise', () => {
    const view = mountEditor('important');
    const text = view.container.textContent ?? '';
    expect(text).toContain('Push');
    expect(text).toContain('Inbox');
    expect(text).not.toContain('Wake');
    view.unmount();
  });

  it('names the same channels Wake and Next turn for a Session receiver, in presets and in Custom', () => {
    const preset = mountEditor('important', 'session');
    const presetText = preset.container.textContent ?? '';
    expect(presetText).toContain('Wake');
    expect(presetText).toContain('Next turn');
    expect(presetText).not.toContain('Push');
    expect(presetText).not.toContain('Inbox');
    preset.unmount();

    const custom = mountEditor('custom', 'session');
    const customText = custom.container.textContent ?? '';
    expect(customText).toContain('Wake');
    expect(customText).toContain('Next turn');
    expect(customText).not.toContain('Push');
    expect(customText).not.toContain('Inbox');
    custom.unmount();
  });
});

describe('FollowPolicyEditor levels', () => {
  it('offers every level as one radio choice carrying its own meaning, and breaks down only the chosen one', () => {
    const view = mountEditor('important');
    const radios = [...view.container.querySelectorAll('[role="radio"]')];
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false']);
    const text = view.container.textContent ?? '';
    // Each level says what it means, not only the chosen one.
    expect(text).toContain('Interrupts you whenever something happens.');
    expect(text).toContain('Nothing interrupts you.');
    expect(text).toContain('Choose how each event reaches you.');
    // The chosen level's breakdown: each channel, then what is left out, in the Custom rows' own words.
    const legend = view.container.querySelector('[data-testid="follow-policy-editor.legend"]')?.textContent ?? '';
    expect(legend).toContain('Push');
    expect(legend).toContain('Needs you');
    expect(legend).toContain('Inbox');
    expect(legend).toContain('Finished');
    expect(legend).toContain('Off');
    expect(legend).toContain('Every message');
    expect(legend).not.toContain('Not included');
    view.unmount();
  });

  it('replaces the breakdown with each event’s own choice under Custom', () => {
    const view = mountEditor('custom');
    expect(view.container.querySelector('[data-testid="follow-policy-editor.legend"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="follow-policy-editor.event.finished"]')).not.toBeNull();
    view.unmount();
  });
});

describe('FollowPolicyEditor for an external author', () => {
  it('keeps the author’s draft controlled: a preset choice reaches the author and the editor shows it', () => {
    const context = createSurfaceContext();
    const view = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <FollowPolicyEditorExample />
      </PluginUiProvider>,
    );
    const draft = () => view.container.querySelector('[data-testid="author-follow-draft"]')?.textContent ?? '';
    expect(draft()).toContain('important:');
    const quiet = [...view.container.querySelectorAll('[role="radio"],[role="button"],[role="tab"]')]
      .find(node => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === 'Quiet');
    expect(quiet, 'Quiet preset').toBeTruthy();
    act(() => (quiet as HTMLElement).click());
    expect(draft()).toContain('quiet:');
    view.unmount();
  });
});
