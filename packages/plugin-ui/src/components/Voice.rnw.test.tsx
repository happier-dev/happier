import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DictationButton, SetupSteps, TextField, VoiceMarkArt, StatusCell, SetupBlockGrid, SetupBlockTile } from './index.public.js';
import { PluginUiProvider, PluginUiProviderInternal } from './PluginUiProvider.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiPresentationHostProviderInternal } from '../presentationHost/context.js';
import { HappierUiAnimationActivityProviderInternal } from '../environment/context.js';
import * as VoiceComponents from './Voice.js';
import { VoiceAttemptPresentationSchema } from '@happier-dev/protocol/voice/attemptPresentation';

describe('public Voice author composition', () => {
  it('binds live parts once and withdraws hidden presentation demand', async () => {
    expect(VoiceComponents.VoicePresence).toBeTypeOf('function');
    const { VoicePresence, VoiceMark, VoiceStatusLine, VoiceTransport, useVoiceAttempt } = VoiceComponents;
    let mounts = 0;
    let releases = 0;
    const attempt = VoiceAttemptPresentationSchema.parse({ attemptId: 'external-attempt', surfaceState: 'error',
      live: true, muted: false, canStart: false, canStop: false, canMute: false, canCommitInput: false,
      canDismissFailedAttempt: true, canDismissEnded: false, failureKind: 'authentication_required',
      failureMessage: 'Sign in required', recovery: null });
    const host = {
      renderVoicePresence: ({ children }: { children?: React.ReactNode }) => <Binding>{children}</Binding>,
      useVoiceAttempt: () => attempt,
      renderVoiceMark: () => <span>Live mark</span>,
      renderVoiceStatusLine: () => <span>Live status</span>,
      renderVoiceTransport: () => <button>Recover exact attempt</button>,
    };
    function Binding({ children }: { children?: React.ReactNode }) {
      React.useEffect(() => { mounts += 1; return () => { releases += 1; }; }, []);
      return <>{children}</>;
    }
    function ReadAttempt() { return <span>{useVoiceAttempt()?.failureMessage}</span>; }
    const render = (active: boolean) => <PluginUiPresentationHostProviderInternal host={host}>
      <HappierUiAnimationActivityProviderInternal active={active}>
        <VoicePresence target={{ kind: 'global' }} presented>
          <VoiceMark size={24} /><VoiceStatusLine size="pill" /><VoiceTransport size="pill" /><ReadAttempt />
        </VoicePresence>
      </HappierUiAnimationActivityProviderInternal>
    </PluginUiPresentationHostProviderInternal>;
    const view = mountThroughReactNativeWeb(render(false));
    expect(mounts).toBe(0);
    expect(view.container.textContent).toBe('');
    await view.render(render(true));
    expect(mounts).toBe(1);
    expect(view.container.textContent).toContain('Live markLive statusRecover exact attemptSign in required');
    await view.render(render(false));
    expect(releases).toBe(1);
    expect(view.container.textContent).toBe('');
    view.unmount();
  });

  it('keeps field editability and Dictation admission together without submitting the draft', async () => {
    const context = createSurfaceContext();
    const onTranscription = vi.fn();
    const onSubmitEditing = vi.fn();
    // The same-realm host bridge is the capture boundary; the public field remains real.
    const host = {
      renderIcon: () => null,
      renderDictationButton: (input: { disabled?: boolean; onTranscription(text: string): void }) => (
        <button disabled={input.disabled} onClick={() => input.onTranscription('Editable words')}>Dictate</button>
      ),
    };
    const hostApi = createHostApiStub(context);
    const render = (disabled: boolean, dictationAvailable = true) => <PluginUiProviderInternal hostApi={hostApi} context={context} surfaceActivity={{ active: true }}>
      <PluginUiPresentationHostProviderInternal host={host}>
        <TextField label="Draft" value="Typed words" onChange={() => undefined} onSubmitEditing={onSubmitEditing}
          disabled={disabled} dictation={dictationAvailable ? { onTranscription } : undefined} />
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProviderInternal>;
    const view = mountThroughReactNativeWeb(render(true));
    expect(view.container.querySelector('button')?.disabled).toBe(true);
    expect(view.container.querySelector('input')?.disabled).toBe(true);
    await view.render(render(false));
    await act(async () => { view.container.querySelector('button')?.click(); });
    expect(onTranscription).toHaveBeenCalledWith('Editable words');
    expect(view.container.querySelector('input')?.value).toBe('Typed words');
    expect(onSubmitEditing).not.toHaveBeenCalled();
    view.container.querySelector('input')?.focus();
    expect(document.activeElement).toBe(view.container.querySelector('input'));
    await view.render(render(false, false));
    expect(document.activeElement).toBe(view.container.querySelector('input'));
    expect(view.container.querySelector('input')?.value).toBe('Typed words');
    view.unmount();
  });

  it('renders ordered setup instructions through the shared step owner', () => {
    const context = createSurfaceContext();
    const view = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <SetupSteps steps={[{ key: 'service', title: 'Choose service', state: 'done' },
        { key: 'try', title: 'Try it', state: 'current', body: <span>Editable input</span> }]} />
    </PluginUiProvider>);
    expect(view.container.querySelector('[role="list"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Choose service');
    expect(view.container.textContent).toContain('2');
    expect(view.container.textContent).toContain('Editable input');
    view.unmount();
  });

  it('keeps an ordinary text input usable when the host has no Dictation or mark renderer', () => {
    const context = createSurfaceContext();
    const onChange = vi.fn();
    const view = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <TextField label="Draft" value="Keep this draft" onChange={onChange} />
      <DictationButton onTranscription={onChange} fallback={<span>Dictation unavailable</span>} />
      <VoiceMarkArt pose="mic" size={24} fallback={<span>Voice</span>} />
    </PluginUiProvider>);
    expect(view.container.querySelector('input')?.value).toBe('Keep this draft');
    expect(view.container.textContent).toContain('Dictation unavailable');
    expect(view.container.textContent).toContain('Voice');
    expect(onChange).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps the author fallback when an older host has no compact transcript binding', () => {
    const { VoiceCompactTranscript } = VoiceComponents;
    expect(VoiceCompactTranscript).toBeTypeOf('function');
    const view = mountThroughReactNativeWeb(<PluginUiPresentationHostProviderInternal host={{}}>
      <VoiceCompactTranscript fallback={<span>Conversation preview unavailable</span>} />
    </PluginUiPresentationHostProviderInternal>);
    expect(view.container.textContent).toBe('Conversation preview unavailable');
    view.unmount();
  });

  it('uses host presentation bindings and prevents hidden parents from reactivating Dictation', async () => {
    const context = createSurfaceContext();
    const onTranscription = vi.fn();
    // Same-realm host bridge is the system boundary; no Brand or Dictation domain logic is mocked.
    const host = {
      renderIcon: () => null,
      renderVoiceMarkArt: () => <span>Static art</span>,
      renderStatusCell: () => <span>Work fact</span>,
      renderSetupBlockTile: () => <span>Set up service</span>,
      renderSetupBlockGrid: () => <span>Set up grid</span>,
      renderDictationButton: (input: { presented: boolean; disabled?: boolean; onTranscription(text: string): void }) => (
        <button disabled={!input.presented || input.disabled} onClick={() => input.onTranscription('Editable words')}>Dictate</button>
      ),
    };
    const hostApi = createHostApiStub(context);
    const render = (active: boolean) => <PluginUiProviderInternal hostApi={hostApi} context={context} surfaceActivity={{ active: true }}>
      <PluginUiPresentationHostProviderInternal host={host}>
        <HappierUiAnimationActivityProviderInternal active={active}>
          <VoiceMarkArt pose="ready" size={24} theme="light" light={[1, 0, 1]} still />
          <StatusCell kind="working" label="Checking service" />
          <SetupBlockGrid testID="grid" items={[]} />
          <SetupBlockTile testID="tile" layout="row" title="Service" subtitle="Configure it"
            action={{ label: 'Set up', testID: 'setup', onPress() {} }} />
          <DictationButton onTranscription={onTranscription} presented />
        </HappierUiAnimationActivityProviderInternal>
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProviderInternal>;
    const view = mountThroughReactNativeWeb(render(false));
    expect(view.container.textContent).toContain('Static art');
    expect(view.container.textContent).toContain('Set up grid');
    expect(view.container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Checking service');
    expect(view.container.querySelector('button')?.disabled).toBe(true);
    await view.render(render(true));
    expect(view.container.querySelector('button')?.disabled).toBe(false);
    await act(async () => { view.container.querySelector('button')?.click(); });
    expect(onTranscription).toHaveBeenCalledWith('Editable words');
    view.unmount();
  });
});
