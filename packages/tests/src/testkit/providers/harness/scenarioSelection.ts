import { resolveProviderAuthOverlay } from './providerAuthOverlay';

import type { ProviderScenario, ProviderUnderTest } from '../types';
import { scenarioCatalog } from '../scenarios/scenarioCatalog';

export function resolveScenarioById(params: { provider: ProviderUnderTest; id: string; expectedTier?: 'smoke' | 'extended' }): ProviderScenario {
  const factory = scenarioCatalog[params.id];
  if (!factory) throw new Error(`Unknown scenario id: ${params.id}`);
  const scenario = factory(params.provider);
  if (!scenario || typeof scenario !== 'object') throw new Error(`Scenario factory returned invalid scenario: ${params.id}`);
  if (scenario.id !== params.id) throw new Error(`Scenario factory returned mismatched id: expected ${params.id}, got ${scenario.id}`);
  if (params.expectedTier) {
    const tier = scenario.tier as 'smoke' | 'extended' | undefined;
    if (tier && tier !== params.expectedTier) {
      throw new Error(`Scenario tier mismatch (${params.id}): expected ${params.expectedTier}, got ${tier}`);
    }
  }
  return scenario;
}

export function resolveScenariosForProvider(params: { provider: ProviderUnderTest; tier: 'smoke' | 'extended' }): ProviderScenario[] {
  const ids = (() => {
    const registry = params.provider.scenarioRegistry as any;
    const tiersByAuthMode = registry?.tiersByAuthMode as
      | { host?: { smoke: string[]; extended: string[] }; env?: { smoke: string[]; extended: string[] } }
      | undefined;
    if (!tiersByAuthMode) return params.provider.scenarioRegistry.tiers[params.tier] ?? [];

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(params.provider.cli.env ?? {}),
      ...Object.fromEntries(
        Object.entries(params.provider.cli.envFrom ?? {}).flatMap(([dest, src]) => {
          const value = typeof process.env[src] === 'string' ? process.env[src]!.trim() : '';
          return value ? [[dest, value]] : [];
        }),
      ),
    };
    const { mode } = resolveProviderAuthOverlay({ auth: params.provider.auth, baseEnv });

    const override = (tiersByAuthMode as any)?.[mode]?.[params.tier] as string[] | undefined;
    return override ?? params.provider.scenarioRegistry.tiers[params.tier] ?? [];
  })();
  return ids.map((id) => resolveScenarioById({ provider: params.provider, id, expectedTier: params.tier }));
}

export function selectScenariosFromRegistry(params: {
  scenarios: ProviderScenario[];
  registry: ProviderUnderTest['scenarioRegistry'];
  tier: 'smoke' | 'extended';
}): ProviderScenario[] {
  const ids = params.registry.tiers[params.tier] ?? [];
  const byId = new Map(params.scenarios.map((scenario) => [scenario.id, scenario] as const));
  const selected: ProviderScenario[] = [];

  for (const id of ids) {
    const scenario = byId.get(id);
    if (!scenario) throw new Error(`Scenario registry references unknown scenario id: ${id}`);
    const tier = (scenario.tier ?? 'extended') as 'smoke' | 'extended';
    if (tier !== params.tier) {
      throw new Error(`Scenario registry references scenario with mismatched tier (${id}): expected ${params.tier}, got ${tier}`);
    }
    selected.push(scenario);
  }

  return selected;
}

export function parseScenarioFilter(): { ids: Set<string> | null; tier: 'smoke' | 'extended' | null } {
  const rawIds =
    typeof (process.env.HAPPIER_E2E_PROVIDER_SCENARIOS ?? process.env.HAPPY_E2E_PROVIDER_SCENARIOS) === 'string'
      ? (process.env.HAPPIER_E2E_PROVIDER_SCENARIOS ?? process.env.HAPPY_E2E_PROVIDER_SCENARIOS)?.trim() ?? ''
      : '';
  if (rawIds) {
    const ids = new Set(rawIds.split(',').map((value) => value.trim()).filter((value) => value.length > 0));
    return { ids: ids.size ? ids : null, tier: null };
  }

  const rawTier =
    typeof (process.env.HAPPIER_E2E_PROVIDER_SCENARIO_TIER ?? process.env.HAPPY_E2E_PROVIDER_SCENARIO_TIER) === 'string'
      ? (process.env.HAPPIER_E2E_PROVIDER_SCENARIO_TIER ?? process.env.HAPPY_E2E_PROVIDER_SCENARIO_TIER)?.trim() ?? ''
      : '';
  if (!rawTier) return { ids: null, tier: null };
  const tier = rawTier === 'smoke' || rawTier === 'extended' ? rawTier : null;
  return { ids: null, tier };
}
