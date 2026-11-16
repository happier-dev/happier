import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createCodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const { CodeReferencesPanel } = await import('./CodeReferencesPanel');

afterEach(() => {
  standardCleanup();
});

describe('CodeReferencesPanel', () => {
  it('says a failed call lookup in the shared inline notice and looks again from its Retry', async () => {
    // No language server answers for this file: the real controller reports the lookup unavailable.
    const controller = createCodeIntelligenceController({
      scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
      path: 'src/a.ts',
      languageId: 'typescript',
      accountLifetime: {
        scope: { serverId: 'home', accountId: 'account' },
        isCurrent: () => true,
        onRetire: () => ({ dispose() {} }),
      },
      getText: () => 'const value = 1;',
      query: async () => ({
        status: 'unavailable',
        reason: 'no_capable_server',
      }),
      openLocation() {},
    });
    const lookups = vi.spyOn(controller, 'callHierarchy');
    const screen = await renderScreen(
      <CodeReferencesPanel
        controller={controller}
        position={{ line: 0, character: 6 }}
        supportsCalls
        references={{
          rows: [],
          textMatches: false,
          partial: false,
          searching: false,
          progress: null,
          onOpen: () => {},
        }}
      />,
    );

    await screen.pressByTestIdAsync('code-navigation-tab:calls');
    await vi.waitFor(() =>
      expect(screen.findHostByTestId('code-calls-failed')).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain('files.pane.intelligence.noInfo');
    const before = lookups.mock.calls.length;

    await screen.pressByTestIdAsync('code-calls-retry');
    await vi.waitFor(() =>
      expect(lookups.mock.calls.length).toBeGreaterThan(before),
    );
  });
});
