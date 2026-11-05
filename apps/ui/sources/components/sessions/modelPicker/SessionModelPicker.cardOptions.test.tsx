/**
 * Only the selected model card carries options (owner 2026-11-04, matching the 0.2 engine popover): every
 * other card is its name and description, even when its descriptor declares effort tiers. Picking that card
 * selects it; then its card shows its own options.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { renderScreen } from '@/dev/testkit';
import { SessionModelPicker } from './SessionModelPicker';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

const AGENT = 'agent:happier.agent.codex/codex';
const connectionId = ProviderConnectionIdSchema.parse('pc_vercel');
const thinking = {
  id: 'reasoning_effort',
  name: 'Thinking',
  type: 'select' as const,
  currentValue: 'high',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
  ],
};

function row(modelId: string, name: string) {
  const ref = {
    agentTargetKey: AGENT,
    providerConnectionId: connectionId,
    modelId,
  };
  return {
    ref,
    descriptor: { id: modelId, name, modelOptions: [thinking] },
    sources: { manual: false, static: true, probe: false },
    confidence: 'verified_static' as const,
    compatibility: {
      result: {
        status: 'experimental' as const,
        selectedProtocol: 'openai-responses' as const,
        reasons: ['compatibility_evidence_missing' as const],
        confirmationScope: { kind: 'connection' as const },
      },
      compatibilityFingerprint: `compatibility:v1:${modelId}`,
      confirmed: true,
    },
    endpointHealth: 'available' as const,
    catalog: { stale: false },
    loadState: 'unknown' as const,
    visibility: 'visible' as const,
  };
}

function groups(rows: ReturnType<typeof row>[]) {
  return [
    {
      connectionId,
      providerName: 'Vercel AI Gateway',
      connectionName: 'Work',
      connectionRole: 'named' as const,
      connectionDisplayNameMode: 'custom' as const,
      connectionRevision: 1,
      authorization: { authorized: true as const },
      manualModelPolicy: 'catalog-only' as const,
      supportsFreeformModelIds: false,
      suppressedConnectedServiceIds: [],
      modelLoadAction: 'descriptor_absent' as const,
      rows,
    },
  ];
}

describe('SessionModelPicker model cards', () => {
  it('draws options only on the selected card, even when other cards declare their own', async () => {
    const lightning = row('nvidia/nemotron-3.5-lightning', 'Nemotron 3.5 Lightning 30B');
    const free = row('nvidia/nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning Free');
    const screen = await renderScreen(
      <SessionModelPicker
        multiColumn
        agentTargetKey={AGENT}
        nativeModels={[]}
        providerGroups={groups([lightning, free])}
        providerProjectionAuthoritative
        selected={free.ref}
        modelOptionOverrides={{ reasoning_effort: 'low' }}
        onSelectOptionControlValue={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const ids = screen.findAll((node) => typeof node.props?.testID === 'string').map((node) => String(node.props.testID));
    expect(ids.filter((id) => id === 'model-picker-overlay-selected-controls').length).toBe(1);
    expect(ids.some((id) => id.startsWith('model-picker-overlay-selected-option-control:reasoning_effort'))).toBe(true);
    expect(ids.filter((id) => id.startsWith('model-picker-overlay-card-option-control') || id.startsWith('model-picker-overlay-option-controls:'))).toEqual([]);
    await screen.unmount();
  });
});
