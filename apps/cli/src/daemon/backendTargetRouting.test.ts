import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCustomAcpAdmissionRuntimeFixture } from './startup/customAcpAdmission.testkit';
import {
  normalizeDaemonBackendTargetV2Input,
  resolveDaemonCatalogAgentIdFromBackendTarget,
  resolveDaemonCliSubcommandFromBackendTarget,
} from './backendTargetRouting';

describe('backendTargetRouting', () => {
  let runtime: Awaited<ReturnType<typeof createCustomAcpAdmissionRuntimeFixture>>;
  beforeAll(async () => { runtime = await createCustomAcpAdmissionRuntimeFixture(); });
  afterAll(async () => { await runtime?.dispose(); });

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

    const admittedTarget = normalizeDaemonBackendTargetV2Input(target) ?? undefined;
    expect(resolveDaemonCatalogAgentIdFromBackendTarget(admittedTarget)).toBeNull();
    expect(resolveDaemonCliSubcommandFromBackendTarget(admittedTarget)).toBe('acp-catalog');
  });

  it('routes configured ACP targets by concrete configured id when the backend id still carries customAcp', () => {
    const target = {
      kind: 'backend',
      backendId: 'customAcp',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    } as const;

    const admittedTarget = normalizeDaemonBackendTargetV2Input(target) ?? undefined;
    expect(admittedTarget).toMatchObject({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
    expect(resolveDaemonCatalogAgentIdFromBackendTarget(admittedTarget)).toBeNull();
    expect(resolveDaemonCliSubcommandFromBackendTarget(admittedTarget)).toBe('acp-catalog');
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
      resolveDaemonCatalogAgentIdFromBackendTarget(normalizeDaemonBackendTargetV2Input({ kind: 'builtInAgent', agentId: 'codex' }) ?? undefined),
    ).toBe('codex');
    expect(
      resolveDaemonCliSubcommandFromBackendTarget(normalizeDaemonBackendTargetV2Input({ kind: 'configuredAcpBackend', backendId: 'review-bot' }) ?? undefined),
    ).toBe('acp-catalog');
    expect(resolveDaemonCatalogAgentIdFromBackendTarget(normalizeDaemonBackendTargetV2Input('agent:codex') ?? undefined)).toBe('codex');
    expect(resolveDaemonCliSubcommandFromBackendTarget(normalizeDaemonBackendTargetV2Input('acpBackend:review-bot') ?? undefined)).toBe('acp-catalog');
  });
});
