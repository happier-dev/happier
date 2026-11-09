import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  openCapabilityAddModal,
  type CapabilityAddModalConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import {
  AgentAddingFrame,
  AgentInstallProgressItem,
  type AgentInstallProgress,
} from '@/components/settings/agents/add/AgentAddingProgress';
import type { AgentAddMachine } from '@/components/settings/agents/add/agentAddRows';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * Dev-only (P9 U9.4 round 2): the agent Add modal's Adding and after-add states (lab aa X / Xp) with a lab cast,
 * through the real shell and the real progress rows, so they can be judged without installing anything on a shared
 * machine. Pressing Add agent resolves `then: 'stay'` with no Action. Deleted when a disposable QA machine can run a
 * real add.
 */
type FixtureAgent = Readonly<{
  id: string;
  name: string;
  description: string;
  publisher: string;
  version: string;
  distribution: string;
  license: string;
}>;

const AGENTS: readonly FixtureAgent[] = [
  {
    id: 'glm',
    name: 'GLM Agent',
    description: 'ACP agent powered by Zhipu AI’s GLM Coding Plan.',
    publisher: 'Stefan de Vogelaere',
    version: '0.4.1',
    distribution: 'npm package',
    license: 'MIT',
  },
  {
    id: 'goose',
    name: 'goose',
    description:
      'A local, extensible, open source AI agent that automates engineering tasks.',
    publisher: 'Block',
    version: '1.54.0',
    distribution: 'Binary download',
    license: 'Apache-2.0',
  },
  {
    id: 'harn',
    name: 'Harn',
    description: 'Runs .harn agent pipelines as a native ACP coding agent.',
    publisher: 'Burin Labs',
    version: '0.9.2',
    distribution: 'Binary download',
    license: 'MIT',
  },
  {
    id: 'junie',
    name: 'Junie',
    description: 'AI coding agent by JetBrains.',
    publisher: 'JetBrains',
    version: '3579.5.0',
    distribution: 'Binary download',
    license: 'Proprietary',
  },
  {
    id: 'kimchi',
    name: 'Kimchi',
    description: 'Coding agent powered by multi-model orchestration.',
    publisher: 'Kimchi',
    version: '0.3.0',
    distribution: 'Binary download',
    license: 'MIT',
  },
];

const MACHINES: readonly (AgentAddMachine & {
  progress: AgentInstallProgress;
})[] = [
  {
    machineId: 'mbp',
    name: 'MacBook Pro',
    platform: 'darwin',
    arch: 'arm64',
    offline: false,
    progress: { phase: 'installed' },
  },
  {
    machineId: 'nl2',
    name: 'nl2',
    platform: 'linux',
    arch: 'x64',
    offline: false,
    progress: {
      phase: 'downloading',
      bytesDone: 76_000_000,
      bytesTotal: 118_000_000,
    },
  },
  {
    machineId: 'nl1',
    name: 'nl1',
    platform: 'linux',
    arch: 'x64',
    offline: false,
    progress: { phase: 'failed', message: 'The download stopped at 41 MB' },
  },
  {
    machineId: 'win',
    name: 'Windows desktop',
    platform: 'win32',
    arch: 'x64',
    offline: true,
    progress: { phase: 'offline' },
  },
];

function Detail(props: Readonly<{ agent: FixtureAgent; added: boolean }>) {
  const { theme } = useUnistyles();
  const { agent } = props;
  return (
    <View style={{ gap: theme.space.s24 }}>
      <CapabilityDetailHeader
        testID="agents.add.detail.header"
        mark={<HappierBrandMark brand={{ displayName: agent.name }} pixelSize={28} externallyLabelled />}
        title={agent.name}
        purpose={agent.description}
        facts={{
          source: { kind: 'registry', label: 'ACP Registry' },
          extra: [agent.publisher, agent.version, agent.license],
        }}
      />
      {props.added ? (
        <AgentAddingFrame name={agent.name} testID="agents.add.adding">
          {MACHINES.map((machine) => (
            <AgentInstallProgressItem
              key={machine.machineId}
              machine={machine}
              progress={machine.progress}
              onRetry={() => undefined}
              onCancel={() => undefined}
              testID={`agents.add.adding.machine.${machine.machineId}`}
            />
          ))}
        </AgentAddingFrame>
      ) : (
        <Text variant="reading" style={{ color: theme.colors.text.secondary }}>
          Fixture details. Press Add agent to see the Adding state.
        </Text>
      )}
    </View>
  );
}

export function AgentAddFixtureSpecimen(
  props: Readonly<{ openOnArrival: boolean }>,
) {
  const { theme } = useUnistyles();
  const open = React.useCallback(() => {
    const config: CapabilityAddModalConfig<FixtureAgent> = {
      title: t('capabilities.agentAdd.title'),
      subtitle: t('capabilities.agentAdd.subtitle'),
      testID: 'agents.add',
      modes: [
        {
          key: 'browse',
          label: t('capabilities.agentAdd.modes.browse'),
          icon: 'magnifying-glass',
          kind: 'catalog',
        },
        {
          key: 'command',
          label: t('capabilities.agentAdd.modes.command'),
          icon: 'terminal',
          kind: 'handoff',
          onSelect: () => undefined,
        },
      ],
      catalog: {
        query: '',
        onQueryChange: () => undefined,
        searchPlaceholder: t('capabilities.agentAdd.searchPlaceholder'),
        items: AGENTS,
        groups: [
          {
            key: 'acp',
            title: 'ACP Registry',
            itemKeys: AGENTS.map((agent) => agent.id),
          },
        ],
        itemKey: (agent) => agent.id,
        anatomy: buildCapabilityCollectionAnatomy<FixtureAgent>({
          title: (agent) => agent.name,
          description: (agent) => agent.description,
          mark: (agent) => <HappierBrandMark brand={{ displayName: agent.name }} pixelSize={20} externallyLabelled />,
          facts: (agent) => ({
            presentation: 'row',
            extra: [
              agent.publisher,
              agent.version,
              agent.distribution,
              agent.license,
            ],
          }),
          accessibilityLabel: (agent) => agent.name,
          testID: (agent) => `agents.add.row.${agent.id}`,
        }),
        loading: false,
        empty: null,
        footer: (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space.s8,
            }}
          >
            <Icon
              name="shield-check"
              size={ICON_SIZE.xs}
              color={theme.colors.text.secondary}
            />
            <Text
              variant="meta"
              style={{ flex: 1, color: theme.colors.text.secondary }}
            >
              {t('capabilities.agentAdd.trustNote')}
            </Text>
          </View>
        ),
      },
      renderDetail: (agent, ctx) => <Detail agent={agent} added={ctx.added} />,
      detailFooter: (agent) => ({
        provenance: (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space.s8,
            }}
          >
            <Icon
              name="lock"
              size={ICON_SIZE.xs}
              color={theme.colors.text.secondary}
            />
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {t('capabilities.agentAdd.footerNote')}
            </Text>
          </View>
        ),
        afterAdd: {
          open: {
            label: t('capabilities.agentAdd.openAgent', { name: agent.name }),
            onPress: () => undefined,
          },
        },
        primary: {
          label: t('capabilities.agentAdd.addAgent'),
          onPress: async () => ({ itemId: agent.id, then: 'stay' as const }),
        },
      }),
    };
    openCapabilityAddModal(config);
  }, [theme]);
  React.useEffect(() => {
    if (!props.openOnArrival) return;
    // The modal host registers after the route mounts: open on the next turn.
    const timer = setTimeout(open, 0);
    return () => clearTimeout(timer);
  }, [open, props.openOnArrival]);
  return (
    <View style={{ padding: theme.space.s24 }}>
      <RoundButton
        title="Open the agent Add fixture"
        onPress={open}
        testID="dev.agentAddFixture.open"
      />
    </View>
  );
}
