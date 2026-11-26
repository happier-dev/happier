import React from 'react';
import { act } from 'react-test-renderer';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { buildToolCallMessageRouteId } from '@happier-dev/session-core/messages';
import { describe, expect, it } from 'vitest';
import { createSessionFixture, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
  createCommittedFiberRenderCounter,
  readTestRendererRoot,
} from '@/dev/testkit/performance/committedFiberCounts';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The real transcript path: store → transcript source → ToolView → ScriptView (themes.F1.card-locality).
await initializeRealAppRuntimeForTests();
const { ToolView } = await import('../../shell/views/ToolView');
const { ScriptView } = await import('./ScriptView');
const { AppSessionTranscriptSourceProvider } =
  await import('@/components/sessions/transcript/source/appSessionTranscriptSource');
const { useSessionTranscriptSource } =
  await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');

const SIBLINGS = 40;
const common = (id: string, seq: number) => ({
  id,
  seq,
  createdAt: seq,
  isSidechain: false,
  localId: null,
});
const call = (
  id: string,
  seq: number,
  name: string,
  input: unknown,
): NormalizedMessage => ({
  ...common(`call-${id}`, seq),
  role: 'agent',
  content: [
    {
      type: 'tool-call',
      id,
      name,
      input,
      description: null,
      uuid: `call-${id}`,
      parentUUID: null,
    },
  ],
});
const result = (
  id: string,
  seq: number,
  content: unknown,
): NormalizedMessage => ({
  ...common(`result-${id}`, seq),
  role: 'agent',
  content: [
    {
      type: 'tool-result',
      tool_use_id: id,
      content,
      is_error: false,
      uuid: `result-${id}`,
      parentUUID: null,
    },
  ],
});

describe('ScriptView render locality (themes.F1.card-locality)', () => {
  it('renders only the Script card when its result lands, and nothing for an unrelated arrival', async () => {
    const serverId = 'script-locality-home';
    const session = createSessionFixture({ id: 'script-locality', serverId });
    const previous = storage.getState();
    const siblings = Array.from({ length: SIBLINGS }, (_, index) => [
      call(`read-${index}`, 10 + index * 2, 'Read', {
        file_path: `/repo/src/file-${index}.ts`,
      }),
      result(`read-${index}`, 11 + index * 2, { content: `line ${index}` }),
    ]).flat();
    const scriptSeq = 10 + SIBLINGS * 2;
    storage.getState().applySessions([session]);
    storage
      .getState()
      .applyMessages(session.id, [
        ...siblings,
        call('script-1', scriptSeq, 'Script', {
          code: 'return await tools.search({ query: "checkout" });',
          title: 'Find checkout tools',
        }),
      ]);
    storage.getState().applyMessagesLoaded(session.id);

    const displaySettings = {
      ...settingsDefaults,
      toolViewExpandedDetailLevelDefault: 'summary',
      toolViewTapAction: 'expand',
    } as const;
    const counter = createCommittedFiberRenderCounter();
    let readRoot: ReturnType<typeof readTestRendererRoot> | undefined;
    function TranscriptRows() {
      const source = useSessionTranscriptSource();
      const ids = source.useMessageIdsOldestFirst();
      const byId = source.useMessagesById();
      return ids.map((id) => {
        const message = byId[id];
        if (message?.kind === 'user-text')
          return <React.Fragment key={id}>{message.text}</React.Fragment>;
        if (message?.kind !== 'tool-call') return null;
        return (
          <ToolView
            key={id}
            tool={message.tool}
            metadata={null}
            messages={message.children}
            sessionId={session.id}
            serverId={serverId}
            messageId={
              buildToolCallMessageRouteId({
                toolId: message.tool.id,
                fallbackMessageId: id,
              }) ?? undefined
            }
            displaySettings={displaySettings}
          />
        );
      });
    }
    const screen = await renderScreen(
      <AppSessionTranscriptSourceProvider
        sessionId={session.id}
        serverId={serverId}
      >
        <React.Profiler
          id="script-card-locality"
          onRender={() => {
            if (readRoot) counter.onCommitRoot(readRoot());
          }}
        >
          <TranscriptRows />
        </React.Profiler>
      </AppSessionTranscriptSourceProvider>,
    );
    readRoot = readTestRendererRoot(screen.tree.root);
    const renders = () => {
      const counts = counter.read();
      return {
        toolViews: counts.rendersFor(ToolView),
        script: counts.rendersFor(ScriptView),
      };
    };
    try {
      expect(screen.findAllByType(ToolView)).toHaveLength(SIBLINGS + 1);
      // Open the Script card the way a person does (its body is demand-mounted), at the summary level.
      const scriptRow = screen.findAllByType(ToolView).at(-1)!;
      await pressTestInstanceAsync(scriptRow.findAll((node) => node.props.testID === 'tool-view-header-primary'
        && typeof node.props.onPress === 'function')[0]!);
      expect(screen.findAllByTestId('script-view').length).toBeGreaterThan(0);

      counter.start();
      await act(async () =>
        storage.getState().applyMessages(session.id, [
          {
            ...common('unrelated', scriptSeq + 1),
            role: 'user',
            content: { type: 'text', text: 'Unrelated arrival' },
          },
        ]),
      );
      expect(screen.getTextContent()).toContain('Unrelated arrival');
      const unrelated = renders();

      counter.start();
      await act(async () =>
        storage
          .getState()
          .applyMessages(session.id, [
            result('script-1', scriptSeq + 2, {
              output: { matches: 3 },
              stdout: 'Searched 3 servers\n',
            }),
          ]),
      );
      const own = renders();
      console.info('script-card-locality-renders', {
        siblings: SIBLINGS,
        unrelated,
        own,
      });

      expect(unrelated).toEqual({ toolViews: 0, script: 0 });
      // The Script row's own card re-renders; none of the 40 sibling cards do.
      expect(own.toolViews).toBe(1);
      expect(own.script).toBeGreaterThanOrEqual(1);
      // The source and console stay unmounted until their disclosure opens.
      expect(screen.findAllByTestId('script-view-code')).toHaveLength(0);
      expect(screen.findAllByTestId('script-view-output')).toHaveLength(0);
    } finally {
      counter.stop();
      await screen.unmount();
      storage.setState(previous, true);
    }
  });
});
