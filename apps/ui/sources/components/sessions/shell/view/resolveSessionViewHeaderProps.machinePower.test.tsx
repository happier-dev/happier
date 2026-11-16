import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { resolveSessionViewHeaderProps } from './resolveSessionViewHeaderProps';

function resolveHeader(
  input: Readonly<{
    metadata: Record<string, unknown>;
    machinePower?: Parameters<
      typeof resolveSessionViewHeaderProps
    >[0]['machinePower'];
    workspaceSubtitle?: string;
  }>,
) {
  const session = createSessionFixture({
    encryptionMode: 'plain',
    active: false,
    activeAt: 100,
    presence: 100,
    metadata: input.metadata as never,
  });
  return resolveSessionViewHeaderProps({
    isDataReady: true,
    session,
    sessionId: session.id,
    sessionInfoHref: `/session/${session.id}/info`,
    sessionRunsHref: `/session/${session.id}/runs`,
    sessionAutomationsHref: `/session/${session.id}/automations`,
    paneScopeId: session.id,
    windowWidth: 1400,
    sessionAutomationsEnabledCount: 0,
    sessionExecutionRunsSupported: true,
    showAutomations: true,
    shouldShowSubagentsButton: false,
    subagentActiveCount: 0,
    navigateWithBlurOnWeb: (action) => action(),
    handleHeaderExtraItemSelect: () => false,
    router: { push: () => {}, navigate: () => {} },
    actionIconColor: '#000',
    headerTintColor: '#000',
    statusErrorColor: '#f00',
    externalSessionRuntime: null,
    workspaceSubtitle: input.workspaceSubtitle,
    machinePower: input.machinePower,
  });
}

// Lab lane12-final b-wake-S #1 / b-wake-A: the header names the created machine and its power word.
describe('resolveSessionViewHeaderProps machine power', () => {
  it('names an asleep machine and its word after the folder', () => {
    const header = resolveHeader({
      metadata: { path: '/home/dev/happier', host: 'host' },
      workspaceSubtitle: '~/happier',
      machinePower: { machineName: 'do-bot-1', word: 'Asleep' },
    });
    expect(header.subtitle).toBe('~/happier · do-bot-1 · Asleep');
  });

  it('keeps the machine and word when the folder repeats the title', () => {
    const metadata = { path: '/home/dev/happier', host: 'host' };
    const { title } = resolveHeader({ metadata });
    const header = resolveHeader({
      metadata,
      workspaceSubtitle: title,
      machinePower: { machineName: 'do-bot-1', word: 'Starting' },
    });
    expect(header.subtitle).toBe('do-bot-1 · Starting');
  });

  it('does not repeat a machine its word already names', () => {
    const header = resolveHeader({
      metadata: { path: '/home/dev/happier', host: 'host' },
      workspaceSubtitle: '~/happier',
      machinePower: { machineName: 'do-bot-1', word: 'Starting do-bot-1…' },
    });
    expect(header.subtitle).toBe('~/happier · Starting do-bot-1…');
  });

  it('says nothing more for a machine without a native power word', () => {
    const header = resolveHeader({
      metadata: { path: '/home/dev/happier', host: 'host' },
      workspaceSubtitle: '~/happier',
      machinePower: null,
    });
    expect(header.subtitle).toBe('~/happier');
  });
});
