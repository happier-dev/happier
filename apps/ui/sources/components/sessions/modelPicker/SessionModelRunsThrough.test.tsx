/**
 * The band's Runs through row lists sources with the Runs-through content model's own rows (UI refinements
 * ruling 2026-11-19): a Provider source reads the label and the one state `buildSessionRouteSourceRows` gives
 * it everywhere else, and the chosen source's usage line sits under the control.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'react-native';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { renderScreen } from '@/dev/testkit';
import { createProviderConnectionViewFixture } from '@/dev/testkit/harness/providerSettingsHarness';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

const { buildSessionRouteSourceRows, presentSessionRouteSourceSubtitle } =
  await import('@/providers/session/buildSessionRouteSourceRows');
const { DropdownMenu } =
  await import('@/components/ui/forms/dropdown/DropdownMenu');
const { SessionModelRunsThrough } = await import('./SessionModelRunsThrough');

const AGENT = 'agent:happier.agent.claude/claude';
const id = (value: string) => ProviderConnectionIdSchema.parse(value);
const option = (providerConnectionId: string | null) => ({
  value: {
    agentTargetKey: AGENT,
    providerConnectionId:
      providerConnectionId === null ? null : id(providerConnectionId),
    modelId: 'sonnet',
  },
  label: 'Sonnet 5.5',
  source: {
    label: providerConnectionId ?? 'Claude subscription · Work pool',
    native: providerConnectionId === null,
  },
});
const routeRows = buildSessionRouteSourceRows({
  declarationContext: { kind: 'account' },
  agentTargetKey: AGENT,
  isGateway: () => false,
  views: [
    createProviderConnectionViewFixture({
      connectionId: 'pc_key',
      providerName: 'Anthropic API key',
      displayName: 'Personal',
      role: 'named',
      displayNameMode: 'custom',
    }),
    createProviderConnectionViewFixture({
      connectionId: 'pc_hidden',
      providerName: 'Vercel AI Gateway',
      displayName: 'Team',
      role: 'named',
      displayNameMode: 'custom',
    }),
    createProviderConnectionViewFixture({
      connectionId: 'pc_off',
      providerName: 'OpenRouter',
      displayName: 'Work',
      role: 'named',
      displayNameMode: 'custom',
      authorized: false,
      authorizationError: createProviderErrorV1(
        'provider_endpoint_unreachable',
      ),
    }),
  ],
  shownSources: [
    { connectionId: 'pc_key', rows: [{}] },
    { connectionId: 'pc_off', rows: [{}] },
  ],
  hiddenSources: [{ connectionId: 'pc_hidden', modelCount: 1 }],
}).providers;
const group = {
  key: 'sonnet',
  upstreamRef: { vendor: 'anthropic', vendorModelId: 'sonnet' },
  sourceCount: 3,
  sources: [
    {
      key: 'native',
      providerConnectionId: null,
      state: 'ready' as const,
      hidden: false,
      options: [option(null)],
    },
    {
      key: 'key',
      providerConnectionId: 'pc_key',
      state: 'ready' as const,
      hidden: false,
      options: [option('pc_key')],
    },
    {
      key: 'hidden',
      providerConnectionId: 'pc_hidden',
      state: 'ready' as const,
      hidden: true,
      options: [],
    },
    {
      key: 'off',
      providerConnectionId: 'pc_off',
      state: 'needs-key' as const,
      hidden: false,
      options: [option('pc_off')],
    },
  ],
};

describe('SessionModelRunsThrough', () => {
  it("lists Provider sources with the Runs-through content model's own label and state", async () => {
    const screen = await renderScreen(
      <SessionModelRunsThrough
        group={group}
        selectedKey={JSON.stringify([AGENT, 'pc_key', 'sonnet'])}
        sourceLabel={() => 'Claude subscription · Work pool'}
        routeRows={routeRows}
        onPick={() => {}}
      />,
    );
    try {
      const items = screen.root.findByType(DropdownMenu).props.items as {
        title: string;
        subtitle?: string;
      }[];
      for (const row of routeRows) {
        expect(items).toContainEqual(
          expect.objectContaining({
            title: row.label,
            subtitle: presentSessionRouteSourceSubtitle(row),
          }),
        );
      }
      expect(items.map((item) => item.title)).toContain(
        'Claude subscription · Work pool',
      );
    } finally {
      await screen.unmount();
    }
  });

  it("shows the chosen source's usage under its control, once", async () => {
    const renderUsage = vi.fn(
      (source: { providerConnectionId: string | null }) => (
        <Text testID={`usage:${source.providerConnectionId}`}>usage</Text>
      ),
    );
    const screen = await renderScreen(
      <SessionModelRunsThrough
        group={group}
        selectedKey={JSON.stringify([AGENT, 'pc_key', 'sonnet'])}
        sourceLabel={() => 'Claude subscription · Work pool'}
        routeRows={routeRows}
        renderUsage={renderUsage}
        onPick={() => {}}
      />,
    );
    try {
      expect(screen.findByTestId('usage:pc_key')).not.toBeNull();
      expect(
        screen.findAll(
          (node) =>
            typeof node.type === 'string' &&
            typeof node.props?.testID === 'string' &&
            node.props.testID.startsWith('usage:'),
        ),
      ).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });
});
