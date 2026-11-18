import * as React from 'react';
import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import {
  useWidgetFrameBodySubjectState,
  useWidgetFrameSubjectStateSaidAbove,
} from '@/components/widgets/frame/widgetFrameBodyCaption';
import {
  WidgetGroupSubjectStateContext,
  WidgetGroupSubjectStateScope,
  useWidgetGroupSubjectState,
} from './widgetGroupSubjectState';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

/** A widget body that lends the state of what it follows and says its own copy only when nothing above says it. */
function Body(props: Readonly<{ id: string; state: string | null }>) {
  useWidgetFrameBodySubjectState(props.state);
  const saidAbove = useWidgetFrameSubjectStateSaidAbove();
  return (
    <Text testID={`${props.id}.own`}>
      {saidAbove ? '' : (props.state ?? '')}
    </Text>
  );
}

function Group(props: Readonly<{ children: React.ReactNode }>) {
  const { state, lend } = useWidgetGroupSubjectState();
  return (
    <WidgetGroupSubjectStateContext.Provider value={lend}>
      <Text testID="header.meta">{state ?? ''}</Text>
      {props.children}
    </WidgetGroupSubjectStateContext.Provider>
  );
}

const offline = 'Offline · Last seen 4 days ago';

describe('Widget group subject state (O2, WAVE-ACCEPT-1118D)', () => {
  it('says the state its following widgets lend once in the header, and only they leave their own copy out', async () => {
    const tree = (children: React.ReactNode) => <Group>{children}</Group>;
    const screen = await renderScreen(
      tree(
        <>
          <WidgetGroupSubjectStateScope instanceId="vitals" follows>
            <Body id="vitals" state={offline} />
          </WidgetGroupSubjectStateScope>
          <WidgetGroupSubjectStateScope instanceId="guard" follows>
            <Body id="guard" state={offline} />
          </WidgetGroupSubjectStateScope>
          {/* Pinned to another value: the header does not name what it follows, so it keeps saying its own state. */}
          <WidgetGroupSubjectStateScope instanceId="pinned" follows={false}>
            <Body id="pinned" state="Offline" />
          </WidgetGroupSubjectStateScope>
        </>,
      ),
    );
    expect(screen.findByTestId('header.meta')?.props.children).toBe(offline);
    expect(screen.findByTestId('vitals.own')?.props.children).toBe('');
    expect(screen.findByTestId('guard.own')?.props.children).toBe('');
    expect(screen.findByTestId('pinned.own')?.props.children).toBe('Offline');

    // One follower leaving keeps the header's words while another still lends them; the last one clears them.
    await screen.update(
      tree(
        <WidgetGroupSubjectStateScope instanceId="guard" follows>
          <Body id="guard" state={offline} />
        </WidgetGroupSubjectStateScope>,
      ),
    );
    expect(screen.findByTestId('header.meta')?.props.children).toBe(offline);
    // Back online: nothing to say, in the header or in the widget.
    await screen.update(
      tree(
        <WidgetGroupSubjectStateScope instanceId="guard" follows>
          <Body id="guard" state={null} />
        </WidgetGroupSubjectStateScope>,
      ),
    );
    expect(screen.findByTestId('header.meta')?.props.children).toBe('');
    await screen.update(tree(null));
    expect(screen.findByTestId('header.meta')?.props.children).toBe('');
    await screen.unmount();
  });

  it('leaves a widget outside any group saying its own state', async () => {
    const screen = await renderScreen(
      <WidgetGroupSubjectStateScope instanceId="alone" follows>
        <Body id="alone" state={offline} />
      </WidgetGroupSubjectStateScope>,
    );
    expect(screen.findByTestId('alone.own')?.props.children).toBe(offline);
    await screen.unmount();
  });
});
