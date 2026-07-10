import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '../manifest.js';
import { legacyCustomAcpCompat } from '../index.js';
import type { AnyAgentRuntimeKindsManifest } from '../runtimeKinds.js';
import { getAgentCatalogDefinition } from './agentDefinitions.js';
import { BACKEND_DEFINITION_AGENT_IDS } from './buildBackendArtifacts.js';
import {
  getAllBackendCatalogDefinitions,
  getBackendCatalogDefinition,
  getAllBackendDefinitionContracts,
  getBackendDefinitionContract,
} from './backendDefinitions.js';
import { buildEngineSpecFromRuntimeKindsManifest } from '../runtime/engine/contracts.js';

describe('backendDefinitions', () => {
  it('assembles one backend definition for every concrete built-in backend id', () => {
    expect(getAllBackendCatalogDefinitions().map((definition) => definition.id).sort()).toEqual([...BACKEND_DEFINITION_AGENT_IDS].sort());
  });

  it('marks customAcp as compatibility-only in the explicit compat agent metadata', () => {
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCore().backendDefinition).toBe(false);
  });

  it('does not expose customAcp as a concrete backend definition id', () => {
    expect(getBackendCatalogDefinition('customAcp')).toBeNull();
  });

  it('derives backend definitions from the existing declarative runtime surfaces', () => {
    const codex = getBackendCatalogDefinition('codex');
    expect(codex).not.toBeNull();
    expect(codex?.agentId).toBe('codex');
    expect(codex?.agent).toBe(getAgentCatalogDefinition('codex'));
    expect(codex?.agent.core).toBe(AGENTS_CORE.codex);
    expect(codex?.runtimeKinds).toBe(AGENTS_CORE.codex.runtimeKinds ?? null);
    expect(codex?.engine).toMatchObject({
      engineId: 'codex',
      defaultRuntimeKind: 'appServer',
      runtimeKinds: {
        acp: {
          kind: 'acp',
          declaredControlSurfaceSupport: AGENTS_CORE.codex.runtimeKinds?.byKind.acp?.overrides ?? null,
        },
        appServer: {
          kind: 'appServer',
          declaredControlSurfaceSupport: AGENTS_CORE.codex.runtimeKinds?.byKind.appServer?.overrides ?? null,
        },
        },
      });
  });

  it('builds engine specs directly from runtime-kind manifests', () => {
    const runtimeKindsManifest = {
      defaultKind: 'server',
      byKind: {
        server: {
          kind: 'server',
          overrides: {
            resume: {
              vendorResume: 'experimental',
            },
          },
        },
        acp: {
          kind: 'acp',
        },
      },
    } satisfies AnyAgentRuntimeKindsManifest;

    expect(
      buildEngineSpecFromRuntimeKindsManifest({
        engineId: 'example',
        runtimeKindsManifest,
      }),
    ).toEqual({
      engineId: 'example',
      defaultRuntimeKind: 'server',
      runtimeKinds: {
        server: {
          kind: 'server',
          declaredControlSurfaceSupport: {
            resume: {
              vendorResume: 'experimental',
            },
          },
        },
        acp: {
          kind: 'acp',
          declaredControlSurfaceSupport: null,
        },
      },
    });
  });

  it('returns null when no runtime-kind manifest is present', () => {
    expect(
      buildEngineSpecFromRuntimeKindsManifest({
        engineId: 'example',
        runtimeKindsManifest: null,
      }),
    ).toBeNull();
  });

  it('derives normalized backend definition contracts from canonical agent metadata', () => {
    expect(getAllBackendDefinitionContracts().map((definition) => definition.id).sort()).toEqual([...BACKEND_DEFINITION_AGENT_IDS].sort());

    const customAcp = getBackendDefinitionContract('customAcp');
    expect(customAcp).toBeNull();

    const codex = getBackendDefinitionContract('codex');
    expect(codex).toEqual(
      expect.objectContaining({
        kindVersion: 1,
        id: 'codex',
        agentId: 'codex',
      }),
    );
  });
});
