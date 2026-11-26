import React from 'react';
import type {
  Message,
  ToolCall,
  ToolCallMessage,
} from '@happier-dev/session-core/messages';
import { describe, expect, it } from 'vitest';

import {
  createTestSessionTranscriptSource,
  pressTestInstanceAsync,
  renderWithSessionTranscriptSource,
} from '@/dev/testkit';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The real shells and the real Script renderer: the detail defaults and the header count are decided by
// their owners (detail-default policy, header text presentation), so nothing here is mocked.
await initializeRealAppRuntimeForTests();
const { ToolView } = await import('./ToolView');
const { ToolTimelineRow } = await import('./ToolTimelineRow');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { t } = await import('@/text');

function scriptTool(state: ToolCall['state']): ToolCall {
  return {
    id: 'toolu_script',
    name: 'Script',
    state,
    input: {
      code: 'for (const pr of prs) await mcp.github.list_check_runs({ ref: pr.sha });',
      title: 'Check CI on checkout PRs',
    },
    ...(state === 'completed'
      ? {
          result: {
            output: [{ pr: 2481 }],
            stdout: 'Checked 6 pull requests\n',
          },
        }
      : {}),
    createdAt: 10,
    startedAt: 10,
    completedAt: state === 'completed' ? 6_410 : null,
    description: null,
  };
}

// Native Code Mode reports inner calls as correlated transcript children, not as runner records.
const children = (count: number): Message[] =>
  Array.from({ length: count }, (_, index): ToolCallMessage => ({
    kind: 'tool-call',
    id: `child-${index}`,
    localId: null,
    createdAt: 11 + index,
    children: [],
    tool: {
      id: `toolu_child_${index}`,
      name: 'Read',
      state: 'completed',
      input: { file_path: `/repo/pr-${index}.ts` },
      createdAt: 11 + index,
      startedAt: 11 + index,
      completedAt: 12 + index,
      description: null,
    },
  }));

async function renderCard(tool: ToolCall, messages: Message[]) {
  return renderWithSessionTranscriptSource(
    <ToolView
      tool={tool}
      metadata={null}
      messages={messages}
      sessionId="s1"
      messageId="m1"
      displaySettings={settingsDefaults}
    />,
    createTestSessionTranscriptSource(),
  );
}

describe('Script in the transcript shells', () => {
  it.each(['running', 'completed'] as const)(
    'counts native child calls in the collapsed header (%s)',
    async (state) => {
      const screen = await renderCard(scriptTool(state), children(6));
      expect(screen.getTextContent()).toContain(
        t('tools.script.toolCallsCount', { count: 6 }),
      );
      // Collapsed is one line: the body is not mounted.
      expect(screen.findAllByTestId('script-view')).toHaveLength(0);
    },
  );

  it('opens to the summary body in card chrome, never the full source dump', async () => {
    const screen = await renderCard(scriptTool('completed'), children(6));
    const header = screen.findAll(
      (node) =>
        node.props.testID === 'tool-view-header-primary' &&
        typeof node.props.onPress === 'function',
    )[0];
    await pressTestInstanceAsync(header!);

    expect(screen.findAllByTestId('script-view').length).toBeGreaterThan(0);
    expect(
      screen.findAllByTestId('transcript-tool-calls-preview-more').length,
    ).toBeGreaterThan(0);
    expect(
      screen.findAllByTestId('script-view-code-toggle').length,
    ).toBeGreaterThan(0);
    expect(screen.findAllByTestId('script-view-code')).toHaveLength(0);
  });

  it('opens to the same summary body in the activity feed', async () => {
    const screen = await renderWithSessionTranscriptSource(
      <ToolTimelineRow
        tool={scriptTool('completed')}
        metadata={null}
        messages={children(6)}
        sessionId="s1"
        messageId="m1"
        displaySettings={{
          ...settingsDefaults,
          toolViewTimelineFeedDefaultExpanded: true,
        }}
      />,
      createTestSessionTranscriptSource(),
    );
    expect(screen.findAllByTestId('script-view').length).toBeGreaterThan(0);
    expect(
      screen.findAllByTestId('transcript-tool-calls-preview-more').length,
    ).toBeGreaterThan(0);
    expect(screen.findAllByTestId('script-view-code')).toHaveLength(0);
  });

  it('honours a per-tool override to open Script in full', async () => {
    const screen = await renderWithSessionTranscriptSource(
      <ToolView
        tool={scriptTool('completed')}
        metadata={null}
        messages={children(6)}
        sessionId="s1"
        messageId="m1"
        displaySettings={{
          ...settingsDefaults,
          toolViewExpandedDetailLevelByToolName: { Script: 'full' },
        }}
      />,
      createTestSessionTranscriptSource(),
    );
    const header = screen.findAll(
      (node) =>
        node.props.testID === 'tool-view-header-primary' &&
        typeof node.props.onPress === 'function',
    )[0];
    await pressTestInstanceAsync(header!);
    expect(
      screen.findAllByTestId('transcript-tool-calls-preview-more'),
    ).toHaveLength(0);
    expect(screen.findAllByTestId('script-view-code-toggle')).toHaveLength(0);
  });
});
