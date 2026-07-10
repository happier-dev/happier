import { describe, expect, it, vi } from 'vitest';

import {
  normalizeAntigravityRuntimeMode,
  resolveAntigravityRuntimeMode,
} from './runtimeMode.js';

describe('Antigravity runtime mode normalization', () => {
  it('accepts only canonical runtime modes', () => {
    expect(normalizeAntigravityRuntimeMode(' auto ')).toBe('auto');
    expect(normalizeAntigravityRuntimeMode('cliPrint')).toBe('cliPrint');
    expect(normalizeAntigravityRuntimeMode('sdk')).toBe('sdk');
    expect(normalizeAntigravityRuntimeMode('')).toBeNull();
    expect(normalizeAntigravityRuntimeMode('cli-print')).toBeNull();
    expect(normalizeAntigravityRuntimeMode('agyPrint')).toBeNull();
  });
});

describe('resolveAntigravityRuntimeMode', () => {
  it('lets the persisted runtime descriptor override requested settings for resume', async () => {
    const result = await resolveAntigravityRuntimeMode({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'antigravity',
        provider: {
          runtimeMode: 'sdk',
        },
      },
      metadata: { antigravityRuntimeMode: 'cliPrint' },
      accountSettings: { antigravityRuntimeMode: 'cliPrint' },
      env: { HAPPIER_ANTIGRAVITY_RUNTIME_MODE: 'cliPrint' },
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    expect(result).toEqual({
      status: 'resolved',
      mode: 'sdk',
      requestedMode: 'sdk',
      source: 'runtimeDescriptor',
    });
  });

  it('prefers explicit metadata over provider settings and env', async () => {
    const result = await resolveAntigravityRuntimeMode({
      metadata: { antigravityRuntimeMode: 'sdk' },
      accountSettings: { antigravityRuntimeMode: 'cliPrint' },
      env: { HAPPIER_ANTIGRAVITY_RUNTIME_MODE: 'cliPrint' },
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    expect(result).toMatchObject({
      status: 'resolved',
      mode: 'sdk',
      requestedMode: 'sdk',
      source: 'metadata',
    });
  });

  it('uses provider settings before the debug env override', async () => {
    const result = await resolveAntigravityRuntimeMode({
      accountSettings: { antigravityRuntimeMode: 'cliPrint' },
      env: { HAPPIER_ANTIGRAVITY_RUNTIME_MODE: 'sdk' },
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    expect(result).toMatchObject({
      status: 'resolved',
      mode: 'cliPrint',
      requestedMode: 'cliPrint',
      source: 'accountSettings',
    });
  });

  it('returns setup diagnostics for explicit cliPrint when the CLI path is unavailable', async () => {
    const isCliPrintAvailable = vi.fn(async () => false);
    const hasSdkCredentials = vi.fn(async () => true);

    const result = await resolveAntigravityRuntimeMode({
      metadata: { antigravityRuntimeMode: 'cliPrint' },
      probes: {
        isCliPrintAvailable,
        hasSdkCredentials,
      },
    });

    expect(result).toEqual({
      status: 'setup_required',
      requestedMode: 'cliPrint',
      source: 'metadata',
      reasonCode: 'antigravity_runtime_unavailable',
      diagnostic: expect.stringContaining('Antigravity CLI'),
    });
    expect(isCliPrintAvailable).toHaveBeenCalledTimes(1);
    expect(hasSdkCredentials).not.toHaveBeenCalled();
  });

  it('returns setup diagnostics for explicit sdk when SDK credentials are unavailable', async () => {
    const isCliPrintAvailable = vi.fn(async () => true);
    const hasSdkCredentials = vi.fn(async () => false);

    const result = await resolveAntigravityRuntimeMode({
      metadata: { antigravityRuntimeMode: 'sdk' },
      probes: {
        isCliPrintAvailable,
        hasSdkCredentials,
      },
    });

    expect(result).toEqual({
      status: 'setup_required',
      requestedMode: 'sdk',
      source: 'metadata',
      reasonCode: 'antigravity_runtime_unavailable',
      diagnostic: expect.stringContaining('Gemini API'),
    });
    expect(hasSdkCredentials).toHaveBeenCalledTimes(1);
    expect(isCliPrintAvailable).not.toHaveBeenCalled();
  });

  it('uses the debug env override when no persisted, metadata, or setting mode is present', async () => {
    const result = await resolveAntigravityRuntimeMode({
      env: { HAPPIER_ANTIGRAVITY_RUNTIME_MODE: 'sdk' },
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    expect(result).toMatchObject({
      status: 'resolved',
      mode: 'sdk',
      requestedMode: 'sdk',
      source: 'env',
    });
  });

  it('resolves auto to cliPrint when the CLI path is available', async () => {
    const result = await resolveAntigravityRuntimeMode({
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    expect(result).toMatchObject({
      status: 'resolved',
      mode: 'cliPrint',
      requestedMode: 'auto',
      source: 'auto',
    });
  });

  it('resolves auto to sdk when CLI is unavailable but SDK credentials are available', async () => {
    const result = await resolveAntigravityRuntimeMode({
      probes: {
        isCliPrintAvailable: vi.fn(async () => false),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    expect(result).toMatchObject({
      status: 'resolved',
      mode: 'sdk',
      requestedMode: 'auto',
      source: 'auto',
    });
  });

  it('returns a setup diagnostic when auto cannot find either concrete runtime path', async () => {
    const result = await resolveAntigravityRuntimeMode({
      probes: {
        isCliPrintAvailable: vi.fn(async () => false),
        hasSdkCredentials: vi.fn(async () => false),
      },
    });

    expect(result).toEqual({
      status: 'setup_required',
      requestedMode: 'auto',
      source: 'auto',
      reasonCode: 'antigravity_runtime_unavailable',
      diagnostic: expect.stringContaining('Antigravity'),
    });
  });
});
