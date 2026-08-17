import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import {
  AgentProviderBindingMaterializationV1Schema as canonicalMaterializationSchema,
} from '../providers/materialization/v1.js';
import {
  AgentSessionProviderBindingV1Schema as canonicalProviderBindingSchema,
} from '../providers/sessions/agentSessionProviderBindingV1.js';
import {
  AgentSessionProviderBindingV1Schema as metadataCompatibilityProviderBindingSchema,
} from '../providers/sessions/bindingMetadataV1.js';
import {
  AgentSessionRealtimeStartRequestV1Schema as canonicalRealtimeStartRequestSchema,
  AgentSessionRealtimeStartResultV1Schema as canonicalRealtimeStartResultSchema,
} from '../voice/realtime/agentSession.js';
import {
  SessionContextUsageSnapshotV1Schema as canonicalContextUsageSchema,
} from '../usage/contextUsage.js';
import {
  UsageObservationContextSchema as canonicalUsageContextSchema,
  UsageObservationCostSchema as canonicalUsageCostSchema,
  UsageObservationScopeSchema as canonicalUsageScopeSchema,
  UsageObservationTokensSchema as canonicalUsageTokensSchema,
} from '../usage/usageAnalyticsContracts.js';
import {
  AgentProviderBindingMaterializationV1Schema,
  AgentSessionProviderBindingV1Schema,
  AgentSessionRealtimeStartRequestV1Schema,
  AgentSessionRealtimeStartResultV1Schema,
  SessionContextUsageSnapshotV1Schema,
  UsageObservationContextSchema,
  UsageObservationCostSchema,
  UsageObservationScopeSchema,
  UsageObservationTokensSchema,
} from './index.js';

const RUNTIME_SCHEMA_EXPORTS = [
  'AgentProviderBindingMaterializationV1Schema',
  'AgentRuntimeJsonValueSchema',
  'AgentSessionProviderBindingV1Schema',
  'AgentSessionRealtimeStartRequestV1Schema',
  'AgentSessionRealtimeStartResultV1Schema',
  'AgentSessionRuntimeEventSchema',
  'AgentSessionRuntimeEventV1Schema',
  'SessionContextUsageSnapshotV1Schema',
  'UsageObservationContextSchema',
  'UsageObservationCostSchema',
  'UsageObservationScopeSchema',
  'UsageObservationTokensSchema',
] as const;

describe('portable Protocol runtime projection', () => {
  it('re-exports the canonical runtime schema objects without reinstantiating them', () => {
    expect(AgentProviderBindingMaterializationV1Schema).toBe(canonicalMaterializationSchema);
    expect(AgentSessionProviderBindingV1Schema).toBe(canonicalProviderBindingSchema);
    expect(metadataCompatibilityProviderBindingSchema).toBe(canonicalProviderBindingSchema);
    expect(AgentSessionRealtimeStartRequestV1Schema).toBe(canonicalRealtimeStartRequestSchema);
    expect(AgentSessionRealtimeStartResultV1Schema).toBe(canonicalRealtimeStartResultSchema);
    expect(SessionContextUsageSnapshotV1Schema).toBe(canonicalContextUsageSchema);
    expect(UsageObservationContextSchema).toBe(canonicalUsageContextSchema);
    expect(UsageObservationCostSchema).toBe(canonicalUsageCostSchema);
    expect(UsageObservationScopeSchema).toBe(canonicalUsageScopeSchema);
    expect(UsageObservationTokensSchema).toBe(canonicalUsageTokensSchema);
  });

  it('isolates the complete schema projection from Node and settings-secret implementation modules', async () => {
    const runtimeEntry = resolve(import.meta.dirname, 'index.ts');
    const moduleIds = new Set<string>();
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [{
        name: 'portable-protocol-runtime-entry',
        resolveId(id) {
          return id === 'virtual:portable-protocol-runtime-entry' ? `\0${id}` : null;
        },
        load(id) {
          if (id !== '\0virtual:portable-protocol-runtime-entry') return null;
          return `export { ${RUNTIME_SCHEMA_EXPORTS.join(', ')} } from ${JSON.stringify(runtimeEntry)};`;
        },
        generateBundle() {
          for (const id of this.getModuleIds()) moduleIds.add(id);
        },
      }],
      build: {
        target: 'es2022',
        write: false,
        rollupOptions: {
          input: 'virtual:portable-protocol-runtime-entry',
          preserveEntrySignatures: 'strict',
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });

    expect([...moduleIds].filter((id) => id.startsWith('node:'))).toEqual([]);
    expect([...moduleIds].some((id) => id.endsWith('/crypto/settingsSecretStringsV1.ts')))
      .toBe(false);
  }, 60_000);
});
