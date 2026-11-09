import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react';

import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
  type PluginUiSessionPartPresentation,
} from '../presentationHost/context.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { SessionChat, SessionComposer, SessionProvider, SessionTranscript, Tabs } from '../index.js';

function presentationHost(
  renderSessionPart?: PluginUiPresentationHost['renderSessionPart'],
): PluginUiPresentationHost {
  return {
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    ...(renderSessionPart === undefined ? {} : { renderSessionPart }),
  };
}

/** A recording host: the bridge is the boundary, so the host's renderer is what the test observes. */
function recordingHost() {
  const calls: PluginUiSessionPartPresentation[] = [];
  const renderSessionPart = vi.fn((input: PluginUiSessionPartPresentation) => {
    calls.push(input);
    if (input.part === 'provider') {
      return <div data-testid={`host-provider:${input.sessionId}`}>{input.children}</div>;
    }
    return <span data-testid={`host-${input.part}`}>{input.part}</span>;
  });
  return { calls, renderSessionPart };
}

function mount(ui: React.ReactNode, host?: PluginUiPresentationHost['renderSessionPart']) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {host === undefined ? ui : (
        <PluginUiPresentationHostProviderInternal host={presentationHost(host)}>
          {ui}
        </PluginUiPresentationHostProviderInternal>
      )}
    </PluginUiProvider>,
  );
}

describe('Session parts', () => {
  it('keeps a retained controller mounted while telling the host which panel is presented', () => {
    const { calls, renderSessionPart } = recordingHost();
    let select: (value: string) => void = () => {};
    let selectOuter: (value: string) => void = () => {};
    function OuterPanels() {
      const [outer, setOuter] = React.useState('inside');
      selectOuter = setOuter;
      return <Tabs value={outer} onValueChange={setOuter}>
        <Tabs.Item value="inside" title="Inside" retention="retain"><Panels /></Tabs.Item>
        <Tabs.Item value="outside" title="Outside">Outside</Tabs.Item>
      </Tabs>;
    }
    function Panels() {
      const [tab, setTab] = React.useState('chat');
      select = setTab;
      return <Tabs value={tab} onValueChange={setTab}>
        <Tabs.Item value="chat" title="Chat" retention="retain"><SessionChat sessionId="retained" /></Tabs.Item>
        <Tabs.Item value="other" title="Other">Other</Tabs.Item>
      </Tabs>;
    }
    const view = mount(<OuterPanels />, renderSessionPart);
    const input = () => calls.filter((call) => call.part === 'chat').at(-1);
    expect(input()).toMatchObject({ presented: true });
    const controller = view.container.querySelector('[data-testid="host-chat"]');
    act(() => { select('other'); });
    expect(input()).toMatchObject({ presented: false });
    expect(view.container.querySelector('[data-testid="host-chat"]')).toBe(controller);
    act(() => { select('chat'); });
    expect(input()).toMatchObject({ presented: true });
    act(() => { selectOuter('outside'); });
    expect(input()).toMatchObject({ presented: false });
    expect(view.container.querySelector('[data-testid="host-chat"]')).toBe(controller);
    act(() => { selectOuter('inside'); });
    expect(input()).toMatchObject({ presented: true });
    expect(view.container.querySelector('[data-testid="host-chat"]')).toBe(controller);
    view.unmount();
  });
  it('renders the author fallback (or nothing) where the host cannot present a Session', () => {
    const view = mount(
      <>
        <SessionChat sessionId="s-1" fallback={<span data-testid="chat-fallback">Open in Happier</span>} />
        <SessionProvider sessionId="s-1" fallback={<span data-testid="provider-fallback">Unavailable</span>}>
          <SessionTranscript />
          <SessionComposer />
        </SessionProvider>
        <SessionChat sessionId="s-2" />
      </>,
    );
    expect(view.container.querySelector('[data-testid="chat-fallback"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="provider-fallback"]')).not.toBeNull();
    expect(view.container.textContent).toBe('Open in HappierUnavailable');
    view.unmount();
  });

  it('hands the host exactly the frozen semantic inputs, one call per part', () => {
    const { calls, renderSessionPart } = recordingHost();
    const view = mount(
      <>
        <SessionProvider sessionId="  s-1  ">
          <SessionTranscript testID="lead-transcript" />
          <SessionComposer />
        </SessionProvider>
        <SessionChat sessionId="s-2" variant="transcript" testID="lead-chat" />
      </>,
      renderSessionPart,
    );

    const provider = calls.find((call) => call.part === 'provider');
    expect(provider).toMatchObject({ part: 'provider', sessionId: 's-1', readOnly: false });
    expect(Object.isFrozen(provider)).toBe(true);
    const transcript = calls.filter((call) => call.part === 'transcript');
    const composer = calls.filter((call) => call.part === 'composer');
    expect(transcript.at(-1)).toEqual({ part: 'transcript', testID: 'lead-transcript' });
    expect(composer.at(-1)).toEqual({ part: 'composer' });
    expect(Object.keys(composer.at(-1)!)).not.toContain('testID');
    expect(calls.filter((call) => call.part === 'chat').at(-1)).toEqual({
      part: 'chat',
      sessionId: 's-2',
      readOnly: true,
      testID: 'lead-chat',
    });
    expect(view.container.querySelector('[data-testid="host-provider:s-1"] [data-testid="host-transcript"]')).not.toBeNull();
    view.unmount();
  });

  it('maps a read-only provider to the host without a composer decision of its own', () => {
    const { calls, renderSessionPart } = recordingHost();
    const view = mount(
      <SessionProvider sessionId="s-1" readOnly>
        <SessionTranscript />
      </SessionProvider>,
      renderSessionPart,
    );
    expect(calls.find((call) => call.part === 'provider')).toMatchObject({ readOnly: true });
    view.unmount();
  });

  it('leaves physical duplicate claims to the host and suppresses only unbound parts', () => {
    const { calls, renderSessionPart } = recordingHost();
    const view = mount(
      <>
        <SessionTranscript testID="orphan" />
        <SessionComposer />
        <SessionProvider sessionId="s-1">
          <SessionTranscript testID="first" />
          <SessionTranscript testID="second" />
          <SessionComposer testID="composer-a" />
          <SessionComposer testID="composer-b" />
        </SessionProvider>
      </>,
      renderSessionPart,
    );
    const transcripts = calls.filter((call) => call.part === 'transcript');
    const composers = calls.filter((call) => call.part === 'composer');
    expect(transcripts.length).toBeGreaterThan(0);
    expect(transcripts.map((call) => call.testID)).toEqual(['first', 'second']);
    expect(composers.map((call) => call.testID)).toEqual(['composer-a', 'composer-b']);
    expect(view.container.querySelectorAll('[data-testid="host-transcript"]')).toHaveLength(2);
    expect(view.container.querySelectorAll('[data-testid="host-composer"]')).toHaveLength(2);
    view.unmount();
  });

  it('renders the fallback for an empty Session id without calling the host', () => {
    const { calls, renderSessionPart } = recordingHost();
    const view = mount(
      <>
        <SessionChat sessionId="   " fallback={<span data-testid="empty-chat">No session</span>} />
        <SessionProvider sessionId="" fallback={<span data-testid="empty-provider">No session</span>}>
          <SessionTranscript />
        </SessionProvider>
      </>,
      renderSessionPart,
    );
    expect(calls).toHaveLength(0);
    expect(view.container.querySelector('[data-testid="empty-chat"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="empty-provider"]')).not.toBeNull();
    view.unmount();
  });
});
