import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
  SessionInfoSectionSummaryProvider,
  useReportSessionInfoSectionSummary,
  useSessionInfoSectionSummaryHost,
  useSessionInfoSectionSummarySessionId,
  type SessionInfoSectionPart,
} from './sessionInfoSectionSummaries';
import type { SessionInfoHeldSectionSummary } from './useSessionInfoAddToFacts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => standardCleanup());

const scope = {
  serverId: 'home-a',
  accountId: 'account-a',
} as unknown as ServerAccountScope;
const address = { serverId: 'home-a', sessionId: 'session-1' };
const held = (
  count: number,
  status: SessionInfoHeldSectionSummary['status'] = 'ready',
): SessionInfoHeldSectionSummary => ({
  scope,
  sessionId: 'session-1',
  status,
  coverage: 'complete',
  count,
});

function Part(
  props: Readonly<{
    part: SessionInfoSectionPart;
    summary: SessionInfoHeldSectionSummary | null;
  }>,
) {
  useReportSessionInfoSectionSummary(props.part, props.summary);
  return null;
}

let observed:
  | ReturnType<typeof useSessionInfoSectionSummaryHost>['facts']
  | null = null;
function Host(
  props: Readonly<{
    parts: readonly [
      SessionInfoSectionPart,
      SessionInfoHeldSectionSummary | null,
    ][];
  }>,
) {
  const host = useSessionInfoSectionSummaryHost({ address, scope });
  observed = host.facts;
  return (
    <SessionInfoSectionSummaryProvider value={host.host}>
      {props.parts.map(([part, summary]) => (
        <Part key={part} part={part} summary={summary} />
      ))}
    </SessionInfoSectionSummaryProvider>
  );
}

describe('Info section summaries', () => {
  it('exposes only the containing Info Session identity and follows its replacement', async () => {
    let sessionId: string | null = null;
    function Identity() {
      sessionId = useSessionInfoSectionSummarySessionId();
      return null;
    }
    function ScopedIdentity(props: Readonly<{ sessionId: string }>) {
      const host = useSessionInfoSectionSummaryHost({
        address: { ...address, sessionId: props.sessionId }, scope,
      });
      return <SessionInfoSectionSummaryProvider value={host.host}><Identity /></SessionInfoSectionSummaryProvider>;
    }
    const screen = await renderScreen(<Identity />);
    expect(sessionId).toBeNull();
    await screen.update(<ScopedIdentity sessionId="session-1" />);
    expect(sessionId).toBe('session-1');
    await screen.update(<ScopedIdentity sessionId="session-2" />);
    expect(sessionId).toBe('session-2');
    await screen.update(<Identity />);
    expect(sessionId).toBeNull();
  });

  it('folds Habits only when what starts here and what writes here are both known empty', async () => {
    const screen = await renderScreen(
      <Host parts={[['habits.startsHere', held(0)]]} />,
    );
    // Writes here has not reported: unknown, never empty.
    expect(observed?.habits).toBe('unknown');
    await act(async () => {
      await screen.update(
        <Host
          parts={[
            ['habits.startsHere', held(0)],
            ['habits.writesHere', held(0, 'loading')],
          ]}
        />,
      );
    });
    expect(observed?.habits).toBe('unknown');
    // A failed read is not an empty one: the section stays, so its "Try again" is never folded away.
    await act(async () => {
      await screen.update(
        <Host
          parts={[
            ['habits.startsHere', held(0, 'error')],
            ['habits.writesHere', held(0)],
          ]}
        />,
      );
    });
    expect(observed?.habits).toBe('unknown');
    await act(async () => {
      await screen.update(
        <Host
          parts={[
            ['habits.startsHere', held(0)],
            ['habits.writesHere', held(0)],
          ]}
        />,
      );
    });
    expect(observed?.habits).toBe('empty');
    await act(async () => {
      await screen.update(
        <Host
          parts={[
            ['habits.startsHere', held(0)],
            ['habits.writesHere', held(2)],
          ]}
        />,
      );
    });
    expect(observed?.habits).toBe('present');
  });

  it('folds Another machine from the Workspace sync summary and forgets a part that unmounts', async () => {
    const screen = await renderScreen(
      <Host parts={[['anotherMachine', held(0)]]} />,
    );
    expect(observed?.anotherMachine).toBe('empty');
    expect(observed?.people).toBe('unknown');
    await act(async () => {
      await screen.update(<Host parts={[]} />);
    });
    expect(observed?.anotherMachine).toBe('unknown');
  });
});
