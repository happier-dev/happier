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
    const target = { kind: 'configuredAcpBackend', backendId: 'review-bot' } as const;

    expect(resolveDaemonCatalogAgentIdFromBackendTarget(target)).toBe('customAcp');
    expect(resolveDaemonCliSubcommandFromBackendTarget(target)).toBe('acp-catalog');
  });

  it('routes known built-in backend targets directly', () => {
    const target = { kind: 'builtInAgent', agentId: 'codex' } as const;

    expect(resolveDaemonCatalogAgentIdFromBackendTarget(target)).toBe('codex');
    expect(resolveDaemonCliSubcommandFromBackendTarget(target)).toBe('codex');
  });

  it('fails closed for unknown built-in backend targets', () => {
    const target = { kind: 'builtInAgent', agentId: 'not-a-real-agent' } as const;

    expect(resolveDaemonCatalogAgentIdFromBackendTarget(target)).toBeNull();
    expect(resolveDaemonCliSubcommandFromBackendTarget(target)).toBeNull();
  });

  it('fails closed when customAcp leaks through as a built-in backend target', () => {
    const target = { kind: 'builtInAgent', agentId: 'customAcp' } as const;

    expect(resolveDaemonCatalogAgentIdFromBackendTarget(target)).toBeNull();
    expect(resolveDaemonCliSubcommandFromBackendTarget(target)).toBeNull();
  });
});
