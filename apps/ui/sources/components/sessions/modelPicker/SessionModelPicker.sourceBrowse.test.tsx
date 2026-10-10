import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import {
  createProviderModelProjectionFixture,
  createProviderModelProjectionGroupFixture,
  createProviderSettingsAccountHarness,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';

const { describeProviderModels, projectionRequests } = vi.hoisted(() => ({
  describeProviderModels: vi.fn(),
  projectionRequests: [] as Readonly<{
    serverId: string | null;
    payload: unknown;
  }>[],
}));
// Replace only network delivery; the real client parses the daemon's strict response.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: (
      request: Readonly<{ serverId: string | null; payload: unknown }>,
    ) => {
      projectionRequests.push(request);
      return describeProviderModels(request.payload);
    },
  }),
);

const AGENT = 'agent:happier.agent.codex/codex';
const account = createProviderSettingsAccountHarness();
let serverId = '';

function gatewayRow(modelId: string, name: string) {
  return {
    ref: { agentTargetKey: AGENT, providerConnectionId: 'pc_gateway', modelId },
    descriptor: { id: modelId, name },
    sources: { manual: false, static: true, probe: false },
    confidence: 'verified_static',
    compatibility: {
      result: {
        status: 'verified',
        selectedProtocol: 'openai-responses',
        evidence: {
          sourceUrls: ['https://example.test'],
          verifiedAt: '2026-10-09',
        },
      },
      compatibilityFingerprint: 'compatibility:v1:gateway',
      confirmed: true,
    },
    endpointHealth: 'available',
    catalog: { stale: false },
    loadState: 'unknown',
    visibility: 'visible',
  };
}

const { SessionModelPicker } = await import('./SessionModelPicker');
const { SessionModelSourceBrowseHandoffContext } = await import('./SessionModelSourceBrowseHandoff');
await loadSyncSingletonForTests();

afterEach(async () => {
  standardCleanup();
  await account.reset();
  describeProviderModels.mockReset();
  projectionRequests.length = 0;
});
beforeEach(async () => {
  serverId = (
    await account.restore({ waivedActions: ['providers.models.refresh'] })
  ).serverId;
});

describe('SessionModelPicker source browsing', () => {
  it('reaches a source hidden from the picker, browses it in place, and commits only a picked model', async () => {
    describeProviderModels.mockResolvedValue(
      createProviderModelProjectionFixture({
        agentTargetKey: AGENT,
        groups: [
          createProviderModelProjectionGroupFixture({
            connectionId: 'pc_gateway',
            providerName: 'Main gateway',
            connectionName: 'Main gateway',
            rows: [gatewayRow('fable-5.1', 'Fable 5.1'), gatewayRow('fable-5.2', 'Fable 5.2')],
          }),
        ],
      }),
    );
    const selected = {
      agentTargetKey: AGENT,
      providerConnectionId: null,
      modelId: 'gpt-6.1-sol',
    };
    const onSelect = vi.fn();
    const onToggleFavorite = vi.fn();
    const favoriteRef = { agentTargetKey: AGENT, providerConnectionId: 'pc_gateway', modelId: 'fable-5.1' };
    const screen = await renderScreen(
      <SessionModelPicker
        multiColumn
        agentTargetKey={AGENT}
        nativeModels={[{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]}
        providerGroups={[]}
        providerProjectionAuthoritative
        selected={selected}
        effectiveLabel="GPT-6.1 Sol"
        hiddenSources={[
          {
            connectionId: 'pc_gateway',
            providerName: 'Main gateway',
            connectionName: 'Main gateway',
            connectionRole: 'default',
            connectionDisplayNameMode: 'automatic',
            modelCount: 1,
          },
        ]}
        sourceBrowse={{ machineId: 'machine-a', serverId }}
        onSelect={onSelect}
        favoriteKeys={new Set([sessionModelSelectionKey(favoriteRef)])}
        onToggleFavorite={onToggleFavorite}
        favoriteActionVisibility="all"
        favoriteEntries={[{ ref: selected, label: 'GPT-6.1 Sol' }]}
      />,
    );
    // Ordinary browse makes no scoped request until the person reaches for the source.
    expect(projectionRequests).toHaveLength(0);
    const link = screen.findByTestId('model-picker-hidden-source:pc_gateway');
    expect(link).not.toBeNull();
    await act(async () => {
      (link!.props.onPress as () => void)();
    });
    await flushHookEffects();

    expect(projectionRequests.at(-1)?.payload).toMatchObject({
      sourceConnectionId: 'pc_gateway',
      currentSelection: selected,
    });
    expect(screen.findByTestId('model-picker-source-scope')).not.toBeNull();
    expect(screen.getTextContent()).toContain('agentInput.model.hiddenFromMainPicker');
    const optionLabels = () =>
      (
        screen.findByType(SelectionList).props.rootStep
          .sections as ReadonlyArray<{
          options: ReadonlyArray<{ id: string; label: string }>;
        }>
      ).flatMap((section) => section.options.map((option) => option.label));
    // Only the browsed source; the native selection elsewhere is not reported as missing.
    expect(optionLabels()).toEqual(['Fable 5.1', 'Fable 5.2']);
    expect(onSelect).not.toHaveBeenCalled();
    const favorite = screen.findByTestId(`model-picker-overlay-option-favorite:${sessionModelSelectionKey(favoriteRef)}`);
    expect(favorite).not.toBeNull();
    expect(favorite!.props.accessibilityLabel).toContain('profiles.actions.removeFromFavorites');
    const otherRef = { ...favoriteRef, modelId: 'fable-5.2' };
    const otherFavorite = screen.findByTestId(`model-picker-overlay-option-favorite:${sessionModelSelectionKey(otherRef)}`);
    expect(otherFavorite).not.toBeNull();
    expect(otherFavorite!.props.accessibilityLabel).toContain('profiles.actions.addToFavorites');
    await act(async () => { favorite!.props.onPress(); });
    expect(onToggleFavorite).toHaveBeenCalledWith(favoriteRef);
    expect(onSelect).not.toHaveBeenCalled();

    // Back returns to every shown source without committing anything.
    const back = screen.findByTestId('model-picker-source-scope-back');
    await act(async () => {
      (back!.props.onPress as () => void)();
    });
    expect(screen.findByTestId('model-picker-source-scope')).toBeNull();
    expect(optionLabels()).toEqual(['GPT-6.1 Sol']);
    expect(onSelect).not.toHaveBeenCalled();

    // Browsing again and picking a card commits exactly that model and its source.
    await act(async () => {
      (
        screen.findByTestId('model-picker-hidden-source:pc_gateway')!.props
          .onPress as () => void
      )();
    });
    await flushHookEffects();
    const list = screen.findByType(SelectionList);
    const fable = (
      list.props.rootStep.sections as ReadonlyArray<{
        options: ReadonlyArray<{ id: string; label: string }>;
      }>
    )
      .flatMap((section) => section.options)
      .find((option) => option.label === 'Fable 5.1');
    await act(async () => {
      (list.props.onSelect as (id: string) => void)(fable!.id);
    });
    expect(onSelect).toHaveBeenCalledWith({
      agentTargetKey: AGENT,
      providerConnectionId: 'pc_gateway',
      modelId: 'fable-5.1',
    });
  });

  it('offers no hidden-source line where the host cannot browse', async () => {
    const screen = await renderScreen(
      <SessionModelPicker
        agentTargetKey={AGENT}
        nativeModels={[{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]}
        providerGroups={[]}
        providerProjectionAuthoritative
        selected={null}
        effectiveLabel="GPT-6.1 Sol"
        hiddenSources={[
          {
            connectionId: 'pc_gateway',
            providerName: 'Main gateway',
            connectionName: 'Main gateway',
            connectionRole: 'default',
            connectionDisplayNameMode: 'automatic',
            modelCount: 1,
          },
        ]}
        onSelect={() => {}}
      />,
    );
    expect(screen.findByTestId('model-picker-hidden-sources')).toBeNull();
  });

  it('opens on the source "Runs through" asked for, only for the Agent it was asked for, and commits nothing', async () => {
    describeProviderModels.mockResolvedValue(
      createProviderModelProjectionFixture({
        agentTargetKey: AGENT,
        groups: [
          createProviderModelProjectionGroupFixture({
            connectionId: 'pc_gateway',
            providerName: 'Main gateway',
            connectionName: 'Main gateway',
            rows: [gatewayRow('fable-5.1', 'Fable 5.1')],
          }),
        ],
      }),
    );
    const onSelect = vi.fn();
    const picker = (agentTargetKey: string) => (
      <SessionModelSourceBrowseHandoffContext.Provider
        value={{
          request: { agentTargetKey: AGENT, scope: { connectionId: 'pc_gateway', label: 'Main gateway' }, key: 1 },
          browse: () => {},
        }}
      >
        <SessionModelPicker
          multiColumn
          agentTargetKey={agentTargetKey}
          nativeModels={[{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]}
          providerGroups={[]}
          providerProjectionAuthoritative
          selected={null}
          effectiveLabel="GPT-6.1 Sol"
          sourceBrowse={{ machineId: 'machine-a', serverId }}
          onSelect={onSelect}
        />
      </SessionModelSourceBrowseHandoffContext.Provider>
    );
    const screen = await renderScreen(picker(AGENT));
    await flushHookEffects();
    expect(screen.findByTestId('model-picker-source-scope')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('agentInput.model.hiddenFromMainPicker');
    expect(projectionRequests.at(-1)?.payload).toMatchObject({ sourceConnectionId: 'pc_gateway' });
    expect(onSelect).not.toHaveBeenCalled();
    await screen.unmount();

    const other = await renderScreen(picker('agent:happier.agent.claude/claude'));
    await flushHookEffects();
    expect(other.findByTestId('model-picker-source-scope')).toBeNull();
  });
});
