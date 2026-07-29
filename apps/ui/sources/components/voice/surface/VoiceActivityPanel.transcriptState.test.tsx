import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));

import { VoiceActivityPanel } from './VoiceActivityPanel';

const styles = {
  feedContainer: {}, feedHeader: {}, feedHeaderLeft: {}, feedTitle: {}, feedCount: {},
  feedScroll: {}, feedScrollContent: {}, emptyText: {}, eventRow: {}, eventText: {},
  eventRevealAction: {}, eventRevealText: {},
  provisionalEventText: { opacity: 0.7, fontStyle: 'italic' }, revisionLabel: {}, liveRegion: {},
};

describe('VoiceActivityPanel transcript semantics', () => {
  it('keeps partial text silent to screen readers and visibly provisional', async () => {
    const screen = await renderScreen(<VoiceActivityPanel
      count={1}
      emptyLabel="empty"
      expanded
      entries={[{ id: 'p1', createdAt: 1, kind: 'user', text: 'Hel', transcriptState: 'partial', announce: false, announcementId: 'p1:1' }]}
      eventTextColor="#fff"
      onToggleExpanded={() => undefined}
      styles={styles}
      title="Activity"
      titleColor="#aaa"
      toggleLabel="toggle"
      expandEntryLabel="Show full content"
      collapseEntryLabel="Show less"
      partialLabel="Live"
      correctedLabel="Updated"
      interruptedLabel="Interrupted"
    />);
    const text = screen.findByProps({ children: 'Hel' });
    expect(text.props.accessibilityLiveRegion).toBe('none');
    expect(text.props.style).toContain(styles.provisionalEventText);
    expect(screen.findByProps({ children: 'Live' })).toBeTruthy();
    expect(screen.findByProps({ accessibilityLabel: 'toggle' }).props.accessibilityState).toEqual({ expanded: true });
  });

  it('announces only a newly-finalized correction and does not replay it on collapse', async () => {
    const baseProps = {
      count: 1,
      emptyLabel: 'empty',
      eventTextColor: '#fff',
      onToggleExpanded: () => undefined,
      styles,
      title: 'Activity',
      titleColor: '#aaa',
      toggleLabel: 'toggle',
      expandEntryLabel: 'Show full content',
      collapseEntryLabel: 'Show less',
      partialLabel: 'Live',
      correctedLabel: 'Updated',
      interruptedLabel: 'Interrupted',
    } as const;
    const screen = await renderScreen(<VoiceActivityPanel
      {...baseProps}
      expanded
      entries={[{ id: 'c1', createdAt: 1, kind: 'assistant', text: 'Hello', transcriptState: 'partial', announce: false, announcementId: 'c1:1' }]}
    />);

    await screen.update(<VoiceActivityPanel
      {...baseProps}
      expanded
      entries={[{ id: 'c1', createdAt: 1, kind: 'assistant', text: 'Hello!', transcriptState: 'corrected', announce: true, announcementId: 'c1:2' }]}
    />);

    expect(screen.findByProps({ children: 'Hello!', accessibilityLiveRegion: 'none' })).toBeTruthy();
    expect(screen.findByProps({ accessibilityLiveRegion: 'polite' }).props.accessibilityLabel).toBe('Hello!');
    expect(screen.findByProps({ children: 'Updated' })).toBeTruthy();

    await screen.update(<VoiceActivityPanel
      {...baseProps}
      expanded={false}
      entries={[{ id: 'c1', createdAt: 1, kind: 'assistant', text: 'Hello!', transcriptState: 'corrected', announce: true, announcementId: 'c1:2' }]}
    />);
    expect(screen.findByProps({ accessibilityLiveRegion: 'polite' }).props.accessibilityLabel).toBe('Hello!');
  });

  it('announces every final utterance that arrives in the same store update', async () => {
    const baseProps = {
      count: 2,
      emptyLabel: 'empty',
      expanded: true,
      eventTextColor: '#fff',
      onToggleExpanded: () => undefined,
      styles,
      title: 'Activity',
      titleColor: '#aaa',
      toggleLabel: 'toggle',
      expandEntryLabel: 'Show full content',
      collapseEntryLabel: 'Show less',
      partialLabel: 'Live',
      correctedLabel: 'Updated',
      interruptedLabel: 'Interrupted',
    } as const;
    const screen = await renderScreen(<VoiceActivityPanel {...baseProps} entries={[]} />);

    await screen.update(<VoiceActivityPanel
      {...baseProps}
      entries={[
        { id: 'batch-user', createdAt: 1, kind: 'user', text: 'First final', transcriptState: 'final', announce: true, announcementId: 'batch-user:1' },
        { id: 'batch-assistant', createdAt: 2, kind: 'assistant', text: 'Second final', transcriptState: 'final', announce: true, announcementId: 'batch-assistant:1' },
      ]}
    />);

    expect(screen.findByProps({ accessibilityLiveRegion: 'polite' }).props.accessibilityLabel).toBe('First final. Second final');
  });

  it('labels interrupted text without making it provisional', async () => {
    const screen = await renderScreen(<VoiceActivityPanel
      count={1}
      emptyLabel="empty"
      expanded
      entries={[{ id: 'i1', createdAt: 1, kind: 'assistant', text: 'Full response', transcriptState: 'interrupted', announce: false, announcementId: 'i1:1' }]}
      eventTextColor="#fff"
      onToggleExpanded={() => undefined}
      styles={styles}
      title="Activity"
      titleColor="#aaa"
      toggleLabel="toggle"
      expandEntryLabel="Show full content"
      collapseEntryLabel="Show less"
      partialLabel="Live"
      correctedLabel="Updated"
      interruptedLabel="Interrupted"
    />);

    expect(screen.findByProps({ children: 'Full response' }).props.style).not.toContain(styles.provisionalEventText);
    expect(screen.findByProps({ children: 'Interrupted' })).toBeTruthy();
  });
});
