import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readAgentCatalogSnapshot, runBackendSessionCliCommand } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
  runBackendSessionCliCommand: vi.fn(async () => {}),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

vi.mock('@/cli/runBackendSessionCliCommand', () => ({
  runBackendSessionCliCommand,
}));

import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import {
  resolveDaemonCatalogAgentIdFromBackendTarget,
  resolveDaemonCliSubcommandFromBackendTarget,
} from './backendTargetRouting';

describe('backendTargetRouting', () => {
  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        codex: { id: 'codex', cliSubcommand: 'codex', vendorResumeSupport: 'supported' },
        'acme-agent': {
          id: 'acme-agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'supported',
        },
      },
    });
  });

  it('fails closed when backend target is missing', () => {
    expect(resolveDaemonCatalogAgentIdFromBackendTarget(undefined)).toBeNull();
    expect(resolveDaemonCliSubcommandFromBackendTarget(undefined)).toBeNull();
  });

  it('routes configured ACP backend targets to the ACP runtime path', () => {
    const target = {
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    } as const;

    expect(resolveDaemonCatalogAgentIdFromBackendTarget(target)).toBeNull();
    expect(resolveDaemonCliSubcommandFromBackendTarget(target)).toBe('acp-catalog');
  });

  it('routes configured ACP targets by concrete configured id when the backend id still carries customAcp', () => {
    const target = {
      kind: 'backend',
      backendId: 'customAcp',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    } as never;

    expect(resolveDaemonCatalogAgentIdFromBackendTarget(target)).toBeNull();
    expect(resolveDaemonCliSubcommandFromBackendTarget(target)).toBe('acp-catalog');
  });

  it('routes known built-in backend targets directly', () => {
    const target = {
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    } as const;

    expect(resolveDaemonCatalogAgentIdFromBackendTarget(target)).toBe('codex');
    expect(resolveDaemonCliSubcommandFromBackendTarget(target)).toBe('codex');
  });

  it('routes an installed external Session Agent through the exact active catalog projection', () => {
    const target = {
      kind: 'backend',
      backendId: 'acme-agent',
      sourceKind: 'built_in',
    } as const;

    expect(resolveDaemonCatalogAgentIdFromBackendTarget(target)).toBe('acme-agent');
    expect(resolveDaemonCliSubcommandFromBackendTarget(target)).toBe('acme-agent');
  });

  it('routes an external no-CLI Session Agent subcommand into its generic host session runner', async () => {
    const contribution = projectManifestAgentContribution({
      definition: PluginAgentContributionV2Schema.parse({
        id: 'acme-agent',
        title: 'Acme Agent',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn'],
            cancel: true,
          },
        },
      }),
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: 'com.acme.agent',
    });
    const entry = contribution.catalogEntry;
    expect(entry).not.toBeNull();
    if (!entry?.getCliCommandHandler) throw new Error('Expected projected Session Agent command handler');
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([[entry.id, contribution]]),
      catalogEntriesById: { [entry.id]: entry },
    });

    const subcommand = resolveDaemonCliSubcommandFromBackendTarget({
      kind: 'backend',
      backendId: entry.id,
      sourceKind: 'built_in',
    });
    expect(subcommand).toBe(entry.cliSubcommand);
    if (!subcommand) throw new Error('Expected active catalog subcommand');

    const context = {
      args: [subcommand, '--happy-starting-mode', 'remote'],
      rawArgv: ['happier', subcommand, '--happy-starting-mode', 'remote'],
      terminalRuntime: null,
    };
    await (await entry.getCliCommandHandler())(context);

    expect(runBackendSessionCliCommand).toHaveBeenCalledWith({
      context,
      backendIdForSessionRuntime: 'acme-agent',
      runtimeAuthorityAgentId: 'acme-agent',
      agentIdForAccountSettings: 'acme-agent',
    });
  });

  it('fails closed for unknown built-in backend targets', () => {
    const target = {
      kind: 'backend',
      backendId: 'not-a-real-agent',
      sourceKind: 'built_in',
    } as const;

    expect(resolveDaemonCatalogAgentIdFromBackendTarget(target)).toBeNull();
    expect(resolveDaemonCliSubcommandFromBackendTarget(target)).toBeNull();
  });

  it('fails closed when customAcp leaks through as a built-in backend target', () => {
    const target = {
      kind: 'backend',
      backendId: 'customAcp',
      sourceKind: 'built_in',
    } as const;

    expect(resolveDaemonCatalogAgentIdFromBackendTarget(target)).toBeNull();
    expect(resolveDaemonCliSubcommandFromBackendTarget(target)).toBeNull();
  });

  it('canonicalizes V1 compat carriers into V2 and routes them', () => {
    expect(
      resolveDaemonCatalogAgentIdFromBackendTarget({ kind: 'builtInAgent', agentId: 'codex' } as never),
    ).toBe('codex');
    expect(
      resolveDaemonCliSubcommandFromBackendTarget({ kind: 'configuredAcpBackend', backendId: 'review-bot' } as never),
    ).toBe('acp-catalog');
    expect(resolveDaemonCatalogAgentIdFromBackendTarget('agent:codex' as never)).toBe('codex');
    expect(resolveDaemonCliSubcommandFromBackendTarget('acpBackend:review-bot' as never)).toBe('acp-catalog');
  });
});
