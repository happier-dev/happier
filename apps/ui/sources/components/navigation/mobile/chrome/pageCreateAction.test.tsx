import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';

import {
  usePageCreateAction,
  usePublishPageCreateAction,
  type PageCreateAction,
} from './pageCreateAction';

function Page(
  props: Readonly<{ action: PageCreateAction | null; focused?: boolean }>,
) {
  const focused = props.focused ?? true;
  return (
    <DestinationInstanceContext.Provider
      value={{
        tabId: props.action?.testID ?? 'none',
        ref: { kind: 'home', params: {} },
        pathname: '/boards',
        visible: true,
        focused,
        isFocused: () => focused,
        navigation: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
      }}
    >
      <Publisher action={props.action} />
    </DestinationInstanceContext.Provider>
  );
}

function Publisher(props: Readonly<{ action: PageCreateAction | null }>) {
  usePublishPageCreateAction(props.action);
  return null;
}

let seen: PageCreateAction | null = null;
function Bar() {
  seen = usePageCreateAction();
  return null;
}

describe('page create action', () => {
  it('lends the bar the create action of the page in front, and gives it back when the page leaves', async () => {
    const boards = { label: 'New board', testID: 'boards', onPress: vi.fn() };
    const docs = { label: 'New document', testID: 'docs', onPress: vi.fn() };
    const screen = await renderScreen(
      <>
        <Bar />
        <Page action={boards} />
      </>,
    );
    expect(seen?.label).toBe('New board');
    seen!.onPress();
    expect(boards.onPress).toHaveBeenCalledTimes(1);

    await screen.update(
      <>
        <Bar />
        <Page action={boards} />
        <Page action={docs} />
      </>,
    );
    expect(seen?.label).toBe('New document');

    await screen.update(
      <>
        <Bar />
        <Page action={boards} />
      </>,
    );
    expect(seen?.label).toBe('New board');

    // A retained page behind another publishes nothing; a page without a create action leaves the "+" off.
    await screen.update(
      <>
        <Bar />
        <Page action={boards} focused={false} />
      </>,
    );
    expect(seen).toBeNull();
    await screen.update(
      <>
        <Bar />
        <Page action={null} />
      </>,
    );
    expect(seen).toBeNull();
    await screen.unmount();
  });
});
