import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  SESSION_LIST_SUPPORTING_SECTIONS_NODE,
  type SessionListVirtualizedNode,
} from './sessionListVirtualizedNodes';
import { SessionListFirstGroupContext } from './SessionListGroup';
import type { ScheduledWorkflowRowsRead } from '@/components/workflows/triggers/ScheduledWorkflowSection';

// Genuine third-party render boundary; none of these list tests renders Markdown.
vi.mock(
  'react-native-enriched-markdown/lib/module/web/streamingReveal.js',
  () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
  }),
);

const probe = vi.hoisted(() => ({
  legendProps: null as any,
  legendMounts: 0,
  /** The first-group fact each header cell read on its first commit, before any layout event. */
  firstGroupAtFirstCommit: new Map<string, boolean>(),
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

// Genuine virtualizer boundary: it records the props Legend receives and draws the header cells it is
// handed (a virtualizer draws cells; the supporting cell's own content is not under test here). No
// layout event is ever delivered, as on the first painted frame.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const ReactModule = await import('react');
  const Mount = () => {
    ReactModule.useEffect(() => {
      probe.legendMounts += 1;
    }, []);
    return null;
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    LegendList: ReactModule.forwardRef<unknown, any>((props) => {
      probe.legendProps = props;
      return ReactModule.createElement(
        ReactModule.Fragment,
        null,
        ReactModule.createElement(Mount),
        props.data
          .filter((item: SessionListVirtualizedNode) => item.kind === 'header')
          .map((item: SessionListVirtualizedNode, index: number) =>
            ReactModule.createElement(
              ReactModule.Fragment,
              { key: item.id },
              props.renderItem({ item, index }),
            ),
          ),
      );
    }),
  };
});

const { SessionListVirtualizedContent } =
  await import('./sessionListVirtualizedContent');

function HeaderCell(props: Readonly<{ id: string }>) {
  const first = React.useContext(SessionListFirstGroupContext);
  if (!probe.firstGroupAtFirstCommit.has(props.id))
    probe.firstGroupAtFirstCommit.set(props.id, first);
  return null;
}

const ATTENTION_HEADER: SessionListVirtualizedNode = {
  id: 'header:attention',
  kind: 'header',
  headerKind: 'attention' as never,
};
const PROJECT_HEADER: SessionListVirtualizedNode = {
  id: 'header:project',
  kind: 'header',
  headerKind: 'project',
};
const SESSION_ROW: SessionListVirtualizedNode = {
  id: 'session:a',
  kind: 'session',
};
const SESSION_TAIL: SessionListVirtualizedNode = {
  id: 'session:b',
  kind: 'session',
  isGroupTail: true,
};

function scheduledRead(
  overrides: Partial<ScheduledWorkflowRowsRead>,
): ScheduledWorkflowRowsRead {
  return {
    available: true,
    rows: [],
    status: 'ready',
    retry: () => {},
    serverId: 'srv',
    ...overrides,
  };
}

function build(props: Record<string, unknown>) {
  return React.createElement(SessionListVirtualizedContent as any, {
    nodes: [
      ATTENTION_HEADER,
      SESSION_ROW,
      SESSION_TAIL,
      SESSION_LIST_SUPPORTING_SECTIONS_NODE,
      PROJECT_HEADER,
    ],
    rowHeight: 44,
    safeAreaBottom: 0,
    showDrafts: false,
    renderItem: ({ item }: { item: SessionListVirtualizedNode }) =>
      React.createElement(HeaderCell, { id: item.id }),
    rowExtraData: null,
    onStopScrollEventPropagationOnWeb: () => {},
    ...props,
  });
}

describe('SessionListVirtualizedContent load stability', () => {
  afterEach(() => {
    standardCleanup();
    probe.legendProps = null;
    probe.legendMounts = 0;
    probe.firstGroupAtFirstCommit.clear();
  });

  it('places an unmeasured row at the row height and an unmeasured group label at its label metrics', async () => {
    const screen = await renderScreen(build({ showReminders: false }));
    const estimate = probe.legendProps?.getEstimatedItemSize as
      | ((
          item: SessionListVirtualizedNode,
          index: number,
        ) => number | undefined)
      | undefined;
    expect(estimate).toBeTypeOf('function');
    expect(estimate?.(SESSION_ROW, 1)).toBe(44);
    expect(estimate?.(SESSION_TAIL, 2)).toBe(44);
    // The supporting cell is often empty; an absent group must not reserve a slot.
    expect(estimate?.(SESSION_LIST_SUPPORTING_SECTIONS_NODE, 3)).toBe(0);
    expect(estimate?.(PROJECT_HEADER, 4)).toBe(
      HAPPIER_COLLECTION_LIST_METRICS.groupLabelPaddingTop +
        HAPPIER_COLLECTION_LIST_METRICS.groupLabelHeight,
    );
    await screen.unmount();
  });

  it('spaces the first group below a leading reminder from the first frame, without waiting for its layout', async () => {
    const screen = await renderScreen(
      build({ showReminders: true, reminderLeads: true }),
    );
    expect(probe.firstGroupAtFirstCommit.get(ATTENTION_HEADER.id)).toBe(false);
    expect(probe.firstGroupAtFirstCommit.get(PROJECT_HEADER.id)).toBe(false);
    await screen.unmount();
  });

  it('opens the column with the first group when nothing leads it', async () => {
    const screen = await renderScreen(
      build({ showReminders: true, reminderLeads: false }),
    );
    expect(probe.firstGroupAtFirstCommit.get(ATTENTION_HEADER.id)).toBe(true);
    expect(probe.firstGroupAtFirstCommit.get(PROJECT_HEADER.id)).toBe(true);
    await screen.unmount();
  });

  it('spaces the groups below upcoming scheduled work from the first frame', async () => {
    const row = {
      key: 'k',
    } as unknown as ScheduledWorkflowRowsRead['rows'][number];
    const screen = await renderScreen(
      build({
        showReminders: false,
        scheduledRead: scheduledRead({ rows: [row] }),
      }),
    );
    // Needs you leads every group; the project groups follow Scheduled.
    expect(probe.firstGroupAtFirstCommit.get(ATTENTION_HEADER.id)).toBe(true);
    expect(probe.firstGroupAtFirstCommit.get(PROJECT_HEADER.id)).toBe(false);
    await screen.unmount();
  });

  it('presents the list once, after its upcoming-work read first settles', async () => {
    const screen = await renderScreen(
      build({
        showReminders: false,
        scheduledRead: scheduledRead({ status: 'loading' }),
      }),
    );
    // The shared loading rows stand in; no rows are placed that Scheduled would later push down.
    expect(probe.legendMounts).toBe(0);
    expect(screen.findByTestId('session-list-skeleton')).toBeTruthy();

    await screen.update(
      build({
        showReminders: false,
        scheduledRead: scheduledRead({ status: 'ready' }),
      }),
    );
    expect(probe.legendMounts).toBe(1);
    expect(screen.findByTestId('session-list-skeleton')).toBeNull();

    // A later refresh never takes the presented list back to loading.
    await screen.update(
      build({
        showReminders: false,
        scheduledRead: scheduledRead({ status: 'loading' }),
      }),
    );
    expect(probe.legendMounts).toBe(1);
    expect(screen.findByTestId('session-list-skeleton')).toBeNull();
    await screen.unmount();
  });

  it('presents at once when the read settles as a failure', async () => {
    const screen = await renderScreen(
      build({
        showReminders: false,
        scheduledRead: scheduledRead({ status: 'failed' }),
      }),
    );
    expect(probe.legendMounts).toBe(1);
    await screen.unmount();
  });
});
