import { describe, expect, it } from 'vitest';
import { StyleSheet } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import type { AgentEvent } from '@happier-dev/session-core/raw';

import { TranscriptEventRow } from './TranscriptEventRow';

type CompactionEvent = Extract<AgentEvent, { type: 'context-compaction' }>;

function compaction(
  fields: Omit<CompactionEvent, 'type' | 'lifecycleId'> & Pick<CompactionEvent, 'phase'>,
): CompactionEvent {
  return {
    type: 'context-compaction',
    lifecycleId: 'claude:compaction-1',
    ...fields,
  };
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type HostNode = NonNullable<ReturnType<Screen['findHostByTestId']>>;

function hostText(node: HostNode | null): string {
    if (!node) return '';
    return node.children.map((child) => typeof child === 'string' ? child : hostText(child)).join('');
}

function textOf(screen: Screen, testID: string): string {
    return hostText(screen.findHostByTestId(testID));
}

/** The ink of the row's primary words: its first host Text inside the body column. */
function inkOf(screen: Screen, testID: string): unknown {
    const title = screen.findHostByTestId(`${testID}-body`)?.findAll((node) => String(node.type) === 'Text')[0];
    return StyleSheet.flatten(title?.props.style)?.color;
}

describe('TranscriptEventRow · idle context compaction', () => {
  it('says the conversation was compacted while idle, with measured counts only when both exist', async () => {
    const withCounts = await renderScreen(
      <TranscriptEventRow
        event={compaction({
          phase: 'completed',
          trigger: 'idle',
          tokenCountSource: 'providerReported', tokenCountBefore: 312_000,
          tokenCountAfter: 41_000,
        })}
      />,
    );
    expect(
      textOf(withCounts, 'transcript-event-context-compaction-completed-body'),
    ).toContain('Compacted while idle');
    expect(
      textOf(
        withCounts,
        'transcript-event-context-compaction-completed-detail',
      ),
    ).toContain('312K → 41K tokens · before the prompt cache expired');

    const oneCount = await renderScreen(
      <TranscriptEventRow
        event={compaction({
          phase: 'completed',
          trigger: 'idle',
          tokenCountSource: 'providerReported', tokenCountBefore: 312_000,
        })}
      />,
    );
    expect(
      textOf(oneCount, 'transcript-event-context-compaction-completed-detail'),
    ).toContain('Before the prompt cache expired');
    expect(
      textOf(oneCount, 'transcript-event-context-compaction-completed-detail'),
    ).not.toContain('312K');
  });

  it.each(['providerEstimated', 'derivedEstimate'] as const)('does not present %s counts as measured idle compaction results', async (tokenCountSource) => {
    const screen = await renderScreen(<TranscriptEventRow event={compaction({ phase: 'completed', trigger: 'idle',
      tokenCountBefore: 312_000, tokenCountAfter: 41_000, tokenCountSource })} />);
    const detail = textOf(screen, 'transcript-event-context-compaction-completed-detail');
    expect(detail).toContain('Before the prompt cache expired');
    expect(detail).not.toContain('312K');
  });

  it('never borrows the paused continuation copy for an idle compaction', async () => {
    const screen = await renderScreen(
      <TranscriptEventRow
        event={compaction({
          phase: 'completed',
          trigger: 'idle',
          continuation: 'paused',
          pauseReason: 'agent-idle-after-compaction',
        })}
      />,
    );
    expect(
      textOf(screen, 'transcript-event-context-compaction-completed-body'),
    ).toContain('Compacted while idle');
  });

  it('keeps an idle failure quiet: the shipped words of what stays, in tertiary ink', async () => {
    const idle = await renderScreen(
      <TranscriptEventRow
        event={compaction({ phase: 'failed', trigger: 'idle' })}
      />,
    );
    expect(
      textOf(idle, 'transcript-event-context-compaction-failed-body'),
    ).toContain('Couldn’t compact while idle');
    expect(
      textOf(idle, 'transcript-event-context-compaction-failed-detail'),
    ).toContain('The conversation stays at full size.');

    const manual = await renderScreen(
      <TranscriptEventRow
        event={compaction({ phase: 'failed', trigger: 'manual' })}
      />,
    );
    expect(
      inkOf(idle, 'transcript-event-context-compaction-failed'),
    ).not.toEqual(
      inkOf(manual, 'transcript-event-context-compaction-failed'),
    );
  });

  it('renders idle running words while it runs', async () => {
    const screen = await renderScreen(
      <TranscriptEventRow
        event={compaction({ phase: 'started', trigger: 'idle' })}
      />,
    );
    expect(
      textOf(screen, 'transcript-event-context-compaction-started-body'),
    ).toContain('Compacting while idle…');
  });

  it('leaves every other trigger on its shipped words', async () => {
    for (const trigger of [
      'manual',
      'auto',
      'threshold',
      'overflow',
      'unknown',
    ] as const) {
      const screen = await renderScreen(
        <TranscriptEventRow
          event={compaction({
            phase: 'completed',
            trigger,
            tokenCountSource: 'providerReported', tokenCountBefore: 312_000,
            tokenCountAfter: 41_000,
          })}
        />,
      );
      expect(
        textOf(screen, 'transcript-event-context-compaction-completed-body'),
      ).toContain('Context compacted');
      expect(
        screen.findHostByTestId(
          'transcript-event-context-compaction-completed-detail',
        ),
      ).toBeNull();
    }
  });
});
