import { describe, expect, it } from 'vitest';
import { projectProviderModelReasoningForAgent, readProviderReasoningEffortOption } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { AgentProviderRequirementsV1Schema, ProviderContributionV1Schema } from '@happier-dev/protocol';
import * as pi from '../../../../../packages/plugins/pi/src/index';
import * as omp from '../../../../../packages/plugins/ohmypi/src/index';
import { PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST } from '../../../../../packages/plugins/claude/src/manifest';
import { buildClaudeEffortCliArgs } from '../../../../../packages/plugins/claude/src/agent/runtime/reasoningEffort';
// Composed source test: consume the actual catalog producer, independent of
// an installed plugin artifact that the release publisher rebuilds separately.
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/cliproxyapi/src/provider/contribution';

describe('gateway SDK effort facts at Agent admission', () => {
  it('offers Claude-applicable Muse effort and serializes every offered tier at native launch', () => {
    const provider = ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION);
    const source = provider.managedRuntime?.connectedAccounts?.find(row => row.purpose === 'meta-upstream')
      ?.staticModels?.find(row => row.id === 'muse-spark-1.3-contributor');
    if (!source) throw new Error('Missing real gateway Muse model');
    const support = AgentProviderRequirementsV1Schema.parse(CLAUDE_PLUGIN_MANIFEST.contributes.agents[0]!.providerRequirements);
    const model = projectProviderModelReasoningForAgent(source, support);
    const effort = readProviderReasoningEffortOption(model);
    expect(effort?.options?.map(row => row.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effort?.currentValue).toBe('low');
    for (const option of effort?.options ?? []) {
      expect(buildClaudeEffortCliArgs({ modelId: model.id, effort: option.value, providerModel: model }))
        .toEqual(['--effort', option.value]);
    }
    expect(readProviderReasoningEffortOption(source)?.currentValue).toBe('minimal');
  });
  it.each(['pi', 'ohMyPi'] as const)('preserves Meta minimal effort for %s and materializes native reasoning support', async agentId => {
    const plugin = agentId === 'pi' ? pi : omp;
    const localId = agentId === 'pi' ? 'pi' : 'ohmypi';
    const fixture = await createPluginTestkit({ manifest: plugin.PLUGIN_MANIFEST, module: { activate: plugin.activate } });
    const provider = ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION);
    const family = provider.managedRuntime?.connectedAccounts
      ?.find(row => row.purpose === 'meta-upstream');
    const sourceModel = family?.staticModels?.find(row => row.id === 'muse-spark-1.3-contributor');
    const adapter = fixture.registration('agents', localId)?.providerBinding;
    const support = AgentProviderRequirementsV1Schema.parse(plugin.PLUGIN_MANIFEST.contributes.agents.find(row => row.id === localId)?.providerRequirements);
    if (!sourceModel || !adapter) throw new Error('Missing real gateway model or Agent adapter');
    // This is the same projection and exact-choice admission used by resolve.ts.
    const model = projectProviderModelReasoningForAgent(sourceModel, support);
    expect(readProviderReasoningEffortOption(model)?.options?.map(row => row.value))
      .toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const transport = { id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } as const;
    const result = await adapter.materialize({
      v: 1, prepared: adapter.prepare({ v: 1, agentTargetKey: 'fixture', connectionId: 'gateway', model }),
      binding: { v: 1, agentTargetKey: 'fixture', contributionKey: null,
        selection: { connectionId: 'gateway', model },
        endpoint: { endpointTemplateId: 'responses', normalizedUrl: 'http://127.0.0.1:7777/v1',
          protocol: 'openai-responses', publicHeaders: {} },
        runtimeCredentialTransport: transport, compatibilityFingerprint: 'fixture' },
      credential: { kind: 'apiKey', transport, value: 'fake-downstream' },
    });
    expect(result.kind).toBe('configFile');
    if (result.kind !== 'configFile') throw new Error('Expected native Provider config');
    expect(result.files[0]?.utf8).toContain('"reasoning":true');
  });
});
