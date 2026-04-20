import { describe, expect, it } from 'vitest';

import {
  resolveDaemonCatalogAgentIdFromBackendTarget,
  resolveDaemonCliSubcommandFromBackendTarget,
} from './backendTargetRouting';

describe('backendTargetRouting', () => {
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
