import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { t } from '@/text';
import { resolveExecutionRunSelectionLabel, resolveRunAnsweringEngine, resolveRunNativeModelLabel } from './resolveExecutionRunSelectionLabel';
import { buildScmDiffSummaryModelProfiles } from '@happier-dev/protocol/actions/settings/scmDiffSummaryModels';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveExecutionRunTitle } from './resolveExecutionRunTitle';

describe('resolveExecutionRunSelectionLabel', () => {
  it('names the walkthrough conversation and recipient while retaining the parent tool title', () => {
    const run = { intent: 'scm_diff_summary', display: { title: 'Change summary' } };
    expect(resolveExecutionRunTitle(run, 'conversation')).toBe(t('walkthrough.conversationTitle'));
    expect(resolveExecutionRunTitle(run, 'recipient')).toBe(t('walkthrough.eyebrow'));
    expect(resolveExecutionRunTitle(run)).toBe('Change summary');
  });
  const label = (connectionId: string) =>
    connectionId === 'pc_gateway' ? 'Main gateway' : null;

  it('uses the admitted Machine model title only for the Run’s exact Agent target', () => {
    const profiles = [
      ...buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'claude' },
        models: [{ id: 'gpt-6-luna', name: 'Other Agent model', capabilities: { structuredOutput: 'supported' } }] }),
      ...buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'codex' },
        models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna', capabilities: { structuredOutput: 'supported' } }] }),
    ];
    const native = resolveRunNativeModelLabel({ kind: 'builtInAgent', agentId: 'codex' }, profiles);
    expect(resolveExecutionRunSelectionLabel({ source: 'explicit', modelId: 'gpt-6-luna' }, label, null, native))
      .toBe(`${t('runPage.menu.selectionExplicit')} · GPT-6-Luna`);
    expect(resolveRunNativeModelLabel({ kind: 'builtInAgent', agentId: 'claude' }, profiles)('gpt-6-luna')).toBe('Other Agent model');
    expect(resolveRunNativeModelLabel({ kind: 'builtInAgent', agentId: 'codex' }, profiles)('missing-model')).toBeNull();
    expect(resolveRunNativeModelLabel(null, profiles)('gpt-6-luna')).toBeNull();
    expect(resolveRunNativeModelLabel({ kind: 'builtInAgent', agentId: 'codex' }, profiles, {
      modelSelection: { agentTargetKey: 'agent:codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_gateway'), modelId: 'gpt-6-luna' },
    })('gpt-6-luna')).toBeNull();
  });

  it('says an inherited Run follows the session and names its route and model', () => {
    expect(
      resolveExecutionRunSelectionLabel(
        {
          source: 'inherited',
          modelSelection: {
            agentTargetKey: 'agent:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
            modelId: 'fable-5.1',
          },
        },
        label,
      ),
    ).toBe(
      `${t('runPage.menu.selectionInherited')} · Main gateway · fable-5.1`,
    );
  });

  it('keeps an explicit choice visible and never names a connection the Account no longer has', () => {
    expect(
      resolveExecutionRunSelectionLabel(
        {
          source: 'explicit',
          modelSelection: {
            agentTargetKey: 'agent:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_deleted'),
            modelId: 'gpt-6.1-luna',
          },
        },
        label,
      ),
    ).toBe(`${t('runPage.menu.selectionExplicit')} · gpt-6.1-luna`);
    expect(resolveExecutionRunSelectionLabel(undefined, label)).toBeNull();
  });

  it.each([
    { selection: 'group' as const, groupId: 'pool-work' },
    { selection: 'profile' as const, profileId: 'account-work' },
  ])('names the admitted native account or pool without guessing its current member', binding => {
    expect(resolveExecutionRunSelectionLabel({
      source: 'inherited', modelId: 'sonnet',
      connectedServices: { v: 2, bindingsByServiceId: {
        'happier.connected-service.claude/claude-subscription': { source: 'connected', ...binding },
      } },
    }, label, 'Claude · Work')).toBe(`${t('runPage.menu.selectionInherited')} · Claude · Work · sonnet`);
  });

  it('names a native model by its catalog title and leaves Provider and Team model ids as they are', () => {
    const catalog = (modelId: string) => (modelId === 'claude-haiku-4-5' ? 'Haiku 4.5' : null);
    expect(resolveExecutionRunSelectionLabel({
      source: 'inherited',
      modelSelection: { agentTargetKey: 'agent:claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' },
    }, label, 'Work pool', catalog)).toBe(`${t('runPage.menu.selectionInherited')} · Work pool · Haiku 4.5`);
    expect(resolveExecutionRunSelectionLabel({ source: 'explicit', modelId: 'claude-haiku-4-5' }, label, null, catalog))
      .toBe(`${t('runPage.menu.selectionExplicit')} · Haiku 4.5`);
    // A Provider route names its own model; the Agent's catalog must not rename it.
    expect(resolveExecutionRunSelectionLabel({
      source: 'inherited',
      modelSelection: {
        agentTargetKey: 'agent:claude', providerConnectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
        modelId: 'claude-haiku-4-5',
      },
    }, label, null, catalog)).toBe(`${t('runPage.menu.selectionInherited')} · Main gateway · claude-haiku-4-5`);
    expect(resolveExecutionRunSelectionLabel({
      source: 'inherited', teamCredentialModel: {
        kind: 'team_credential_provider_model', teamId: 'team-work', resourceId: 'resource-work',
        expectedResourceRevision: 2, deliveryMode: 'brokered', agentTargetKey: 'agent:claude', modelId: 'claude-haiku-4-5',
      },
    }, label, 'Work Team', catalog)).toBe(`${t('runPage.menu.selectionInherited')} · Work Team · claude-haiku-4-5`);
  });

  // The Session composer asking a walkthrough has no admitted Machine catalog, but the Session already lists its own
  // Agent's models: the fixed chip names the Run's model by that title ("GPT-6-Luna"), never its id.
  it('names the answering model from the Session model list of the same Agent, and only that Agent', () => {
    const sessionModels = { agentId: 'codex', metadata: { sessionModelsV1: {
      v: 1 as const, agentId: 'codex', updatedAt: 1, currentModelId: 'gpt-6-luna',
      availableModels: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }],
    } } };
    const codex = { kind: 'builtInAgent' as const, agentId: 'codex' };
    expect(resolveRunAnsweringEngine({ backendTarget: codex, modelId: 'gpt-6-luna', sessionModels }))
      .toEqual({ label: 'GPT-6-Luna', agentId: 'codex' });
    expect(resolveRunAnsweringEngine({ backendTarget: codex, modelId: 'gpt-6-luna', sessionModels,
      catalogProfiles: buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'codex' },
        models: [{ id: 'gpt-6-luna', name: 'Different Machine title' }] }) }))
      .toEqual({ label: 'GPT-6-Luna', agentId: 'codex' });
    expect(resolveRunAnsweringEngine({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: 'gpt-6-luna', sessionModels })?.label)
      .toBe('gpt-6-luna');
  });

  it('names a Team resource from its recipient-safe identity', () => {
    expect(resolveExecutionRunSelectionLabel({
      source: 'inherited', teamCredentialModel: {
        kind: 'team_credential_provider_model', teamId: 'team-work', resourceId: 'resource-work',
        expectedResourceRevision: 2, deliveryMode: 'brokered', agentTargetKey: 'agent:codex', modelId: 'sonnet',
      },
    }, label, 'Work Team · Shared Claude')).toBe(`${t('runPage.menu.selectionInherited')} · Work Team · Shared Claude · sonnet`);
  });

  it('renders the recorded native account from the Run Home, not the active Home with the same account id', async () => {
    const { createProviderSettingsAccountHarness } = await import('@/dev/testkit/harness/providerSettingsHarness');
    const { renderScreen, standardCleanup } = await import('@/dev/testkit');
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');
    const { ExecutionRunPublicStateSchema } = await import('@happier-dev/protocol/execution/runs/responseSchemas');
    const account = createProviderSettingsAccountHarness();
    try {
      const active = await account.restore({ accountId: 'account-a' });
      const runHome = await account.addHome({ name: 'Run Home', serverUrl: 'https://run-selection-home.test', accountId: 'account-a', active: false });
      const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
      const profile = (displayName: string) => ({ ...profileDefaults, id: 'account-a', connectedAccountsV4: [{
        ref: { service, accountId: 'opaque-account-id' }, displayName, status: 'connected', authenticationModeId: 'manual',
        revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false,
        configurationRevision: null, scopes: [],
      }] });
      account.home.answer(active.serverId, 'GET /v1/account/profile', { body: profile('Wrong active account') });
      account.home.answer(runHome, 'GET /v1/account/profile', { body: profile('Run account') });
      const { SessionExecutionRunInfoCard } = await import('./details/SessionExecutionRunInfoCard');
      const run = ExecutionRunPublicStateSchema.parse({
        runId: 'run-native', callId: 'call-native', sidechainId: 'side-native', intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
        resolvedSelection: { source: 'inherited', modelId: 'gpt-6-luna', connectedServices: { v: 2, bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'opaque-account-id' },
        } } },
      });
      const nativeModelCatalog = buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(run.backendTarget),
        models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }] });
      const screen = await renderScreen(React.createElement(SessionExecutionRunInfoCard, { run, serverId: runHome, nativeModelCatalog }));
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Run account'));
      expect(screen.getTextContent()).not.toContain('Wrong active account');
      expect(screen.getTextContent()).not.toContain('opaque-account-id');
      expect(screen.getTextContent()).toContain('GPT-6-Luna');
      expect(screen.getTextContent()).not.toContain('gpt-6-luna');
      const { ExecutionRunRow } = await import('./ExecutionRunRow');
      const row = await renderScreen(React.createElement(ExecutionRunRow, { run, serverId: runHome, nativeModelCatalog }));
      await waitForHomeGovernance(() => expect(row.getTextContent()).toContain('Run account'));
      expect(row.getTextContent()).not.toContain('Wrong active account');
      expect(row.getTextContent()).not.toContain('opaque-account-id');
      expect(row.getTextContent()).toContain('GPT-6-Luna');
      expect(row.getTextContent()).not.toContain('gpt-6-luna');
    } finally {
      standardCleanup();
      await account.reset();
    }
  });
});
