import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { ExternalSessionRuntimePresentation } from '@/components/sessions/presentation/externalSessionRuntimePresentation';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { resolveSessionViewHeaderProps } from './resolveSessionViewHeaderProps';
import { SessionHeaderExternalAgentStatus } from './SessionHeaderExternalAgentStatus';

/** The external-Agent status the header's actions row renders, by its host testIDs. */
async function headerTestIds(
  props: ReturnType<typeof resolveSessionViewHeaderProps>,
): Promise<string[]> {
  const pills = React.Children.toArray(
    (props.rightElement as React.ReactElement<{ children?: React.ReactNode }>)
      .props.children,
  ).filter((child) => React.isValidElement(child) && child.type === SessionHeaderExternalAgentStatus);
  const screen = await renderScreen(<>{pills}</>);
  return screen
    .findAll((node) => typeof node.type === 'string' && typeof node.props.testID === 'string')
    .map((node) => node.props.testID as string);
}

function runtime(
  externalAgent: ExternalSessionRuntimePresentation['externalAgent'],
): ExternalSessionRuntimePresentation {
  return {
    controlConnectivity: 'connected',
    detachedActivity: 'unknown',
    externalAgent,
  };
}

function input(externalSessionRuntime: ExternalSessionRuntimePresentation) {
  const session = createSessionFixture({
    id: 'external-status',
    metadata: { path: '/tmp/project', host: 'test-host' },
  });
  return {
    isDataReady: true,
    session,
    sessionId: session.id,
    sessionInfoHref: `/session/${session.id}/info`,
    sessionRunsHref: `/session/${session.id}/runs`,
    sessionAutomationsHref: `/session/${session.id}/automations`,
    paneScopeId: 'pane-1',
    windowWidth: 1200,
    sessionAutomationsEnabledCount: 0,
    sessionExecutionRunsSupported: false,
    showAutomations: false,
    shouldShowSubagentsButton: false,
    subagentActiveCount: 0,
    workSummary: {
      outstanding: 0,
      needsYou: 0,
      stalled: 0,
      sessions: 0,
      runs: 0,
    },
    navigateWithBlurOnWeb: (action: () => void) => action(),
    handleHeaderExtraItemSelect: () => false,
    router: { push: () => {}, navigate: () => {} },
    actionIconColor: '#000',
    headerTintColor: '#000',
    statusErrorColor: '#f00',
    externalSessionRuntime,
  } as const;
}

describe('resolveSessionViewHeaderProps external Agent status', () => {
  it('shows an observed external Agent state and says nothing when there is no current evidence', async () => {
    const working = resolveSessionViewHeaderProps(
      input(
        runtime({
          state: 'working',
          labelKey: 'status.workingExternally',
          tone: 'live',
          indicator: 'working',
          nextExpiryAtMs: null,
        }),
      ),
    );
    expect(await headerTestIds(working)).toContain(
      'session-header-external-agent-status-working',
    );

    const unknown = resolveSessionViewHeaderProps(
      input(
        runtime({
          state: 'unknown',
          labelKey: 'status.externalStatusUnknown',
          tone: 'muted',
          indicator: 'none',
          nextExpiryAtMs: null,
        }),
      ),
    );
    expect(
      (await headerTestIds(unknown)).some((id) =>
        id.startsWith('session-header-external-agent-status'),
      ),
    ).toBe(false);
  });
});
