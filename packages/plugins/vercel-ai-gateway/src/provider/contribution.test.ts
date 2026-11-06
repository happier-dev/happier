import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ProviderUsageParseResultV1Schema } from '@happier-dev/protocol/providers/contributions';
import { ProviderContributionV1Schema } from '@happier-dev/plugin-sdk/providers';
import { resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/plugin-sdk/providers';
import { AgentProviderRequirementsV1Schema } from '@happier-dev/protocol/providers/compatibility/v1';
import { resolveProviderModelPickerVisibility } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { assertBundledProviderVerificationV1 } from '../../../../../apps/cli/scripts/build-owned/bundledProviderVerification';
import claude from '../../../../../apps/cli/assets/bundled-plugin-manifests/claude.json';
import codex from '../../../../../apps/cli/assets/bundled-plugin-manifests/codex.json';
import opencode from '../../../../../apps/cli/assets/bundled-plugin-manifests/opencode.json';
import { PLUGIN_MANIFEST, activate } from '../manifest.js';
import fixture from './catalog/fixtures/catalog.json';
import { parseVercelModels } from './catalog/vercelModelsParser.js';
import verification from './verification/vercel-ai-gateway.json';

describe('Vercel AI Gateway Provider projection', () => {
  it('activates the declared usage source alongside the real catalog parser', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const source = PLUGIN_MANIFEST.contributes.providers[0]!.usageSources![0]!;
      expect(source).toMatchObject({ path: '/v1/credits', endpointTemplateId: 'vercel-chat' });
      expect(source).not.toHaveProperty('billingCredential');
      const result = kit.registration('providers', 'vercel-ai-gateway')?.usageParsers?.[source.parser]?.({ balance: '-0.25', total_used: '1.75' });
      expect(ProviderUsageParseResultV1Schema.parse(result).meters[0]).toMatchObject({ remaining: -0.25, unit: 'usd', limit: null });
    } finally { await kit.dispose(); }
  });
  it('projects the three documented protocol endpoints and API-key transport', () => {
    expect(PLUGIN_MANIFEST).toHaveProperty('entrypoints.daemon', './.happier-plugin/daemon.js');
    const provider = ProviderContributionV1Schema.parse(PLUGIN_MANIFEST.contributes.providers[0]);
    expect(assertBundledProviderVerificationV1({
      buildQualifiedContributionKey: buildQualifiedPluginContributionKey,
      pluginId: PLUGIN_MANIFEST.id, contribution: provider, verification, todayUtc: verification.reviewedAt,
    }).contributionKey).toBe('happier.provider.vercel-ai-gateway/vercel-ai-gateway');
    expect(provider.endpointTemplates.map(({ protocol, baseUrl }) => ({ protocol, baseUrl }))).toEqual([
      { protocol: 'anthropic', baseUrl: 'https://ai-gateway.vercel.sh/claude-code' },
      { protocol: 'openai-responses', baseUrl: 'https://ai-gateway.vercel.sh/codex/v1' },
      { protocol: 'openai-chat', baseUrl: 'https://ai-gateway.vercel.sh/coding-agent/v1' },
    ]);
    expect(provider.credential).toMatchObject({ kind: 'apiKey', required: true,
      transports: [{ protocols: ['anthropic', 'openai-responses', 'openai-chat'], uses: ['probe', 'runtime'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] });
    expect(provider.catalog).toMatchObject({ source: 'probe', probes: [{ path: '/v1/models', parser: 'vercel-ai-gateway-models' }] });
    for (const endpoint of provider.endpointTemplates) {
      expect(endpoint.publicHeaders).toEqual({ 'http-referer': 'https://happier.dev', 'x-title': 'Happier' });
    }
  });

  it('resolves real bundled Agent declarations to their protocol endpoint without bypassing confirmation', () => {
    const provider = ProviderContributionV1Schema.parse(PLUGIN_MANIFEST.contributes.providers[0]);
    const model = parseVercelModels(fixture).models[0]!;
    for (const [manifest, protocol, baseUrl] of [
      [claude, 'anthropic', 'https://ai-gateway.vercel.sh/claude-code'],
      [codex, 'openai-responses', 'https://ai-gateway.vercel.sh/codex/v1'],
      [opencode, 'openai-responses', 'https://ai-gateway.vercel.sh/codex/v1'],
    ] as const) {
      const { result } = resolveProviderBindingCompatibilityWithFingerprintV1({
        agentTargetKey: `agent:${manifest.contributes.agents[0]!.id}`,
        agent: AgentProviderRequirementsV1Schema.parse(manifest.contributes.agents[0]!.providerRequirements),
        endpoints: provider.endpointTemplates, credential: provider.credential, model, adapterVersion: 1,
      });
      expect(result).toMatchObject({ status: 'experimental', selectedProtocol: protocol, reasons: ['compatibility_evidence_missing'] });
      expect(provider.endpointTemplates.find(endpoint => endpoint.protocol === protocol)?.baseUrl).toBe(baseUrl);
    }
    expect(resolveProviderModelPickerVisibility({ connectionId: 'pc_vercel', kind: provider.kind }))
      .toMatchObject({ shown: false, defaultReason: 'manyModels' });
  });
});
