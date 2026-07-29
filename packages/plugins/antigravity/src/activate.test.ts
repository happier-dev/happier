import { describe, expect, it, vi } from 'vitest';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate } from './activate.js';
import { antigravityExternalSessionsContribution } from './agent/cliPrint/externalSessions.js';
import { antigravityExternalSessionObservationContribution } from './agent/cliPrint/observation.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Antigravity plugin activation', () => {
  it('commits the complete Antigravity Agent aggregate through manifest-derived registration rights', async () => {
    const testkit = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    try {
      expect(testkit.registrations()).toContainEqual({
        family: 'agents',
        localId: 'antigravity',
      });
    } finally {
      await testkit.dispose();
    }
  });

  it('registers one native Antigravity runtime with both structured modes and no V1 fallback', async () => {
    const fixture = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });

    expect(fixture.registrations()).toContainEqual({
      family: 'agents',
      localId: 'antigravity',
    });
    const registration = fixture.registration('agents', 'antigravity');
    expect(registration?.factory).toEqual(expect.any(Function));
    expect(registration?.externalSessions).toEqual(
      antigravityExternalSessionsContribution,
    );
    expect(Object.keys(registration?.externalSessions ?? {}).sort()).toEqual([
      'listCandidates',
      'pageTranscript',
      'readAfterTranscript',
      'resolveLinkIdentity',
      'resolveLinkedIdentity',
      'resolveSource',
    ]);
    expect(registration?.externalSessionObservation).toEqual(
      antigravityExternalSessionObservationContribution,
    );
    expect(Object.keys(
      registration?.externalSessionObservation ?? {},
    ).sort()).toEqual([
      'describeResource',
      'observeResource',
      'reconcileResource',
    ]);
    expect(registration?.externalSessionHooks).toBeUndefined();
    expect(registration?.externalSessionTakeover).toBeUndefined();
    expect(fixture.registration('hooks', 'resolve-prerequisites')).toEqual(expect.any(Function));

    const runtime = await registration!.factory!({
      plugin: { id: 'happier.agent.antigravity', version: '0.0.0' },
      agent: { id: 'antigravity' },
      signal: new AbortController().signal,
    });

    expect(runtime.sessions).toEqual({ open: expect.any(Function) });
    expect(runtime.executionRuns).toEqual({ open: expect.any(Function) });
    await fixture.dispose();
  });

  it('routes SDK setup through the canonical managed-dependency service without consulting the predecessor owner', async () => {
    const fixture = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });

    const registration = fixture.registration('hooks', 'resolve-prerequisites');
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: false as const,
      errorMessage: 'missing localharness',
    }));
    const ensure = vi.fn(async () => ({ state: 'ready' as const }));
    const result = await registration?.({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'sdk' },
          env: { GEMINI_API_KEY: 'sdk-key' },
        },
      },
    }, {
      tools: {
        resolveManagedInstallable,
      },
      services: { managed: { dependencies: { ensure } } },
    });

    expect(result).toEqual({ decision: 'allow' });
    expect(resolveManagedInstallable).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith('localharness', undefined);
    await fixture.dispose();
  });

  it('passes direct activation-hook payloads through to the spawn prerequisite owner', async () => {
    const fixture = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      command: '/usr/local/bin/agy',
      args: ['models'],
      exitCode: 0,
      signal: null,
      stdout: 'Gemini 3.5 Flash (Medium)\n',
      stderr: '',
    }));

    const registration = fixture.registration('hooks', 'resolve-prerequisites');
    const result = await registration?.({
      runtimeSelection: {
        providerRuntimeSelection: { antigravityRuntimeMode: 'cliPrint' },
        cwd: '/repo',
        env: { SAFE_TEST_ENV: 'kept' },
      },
    }, {
      tools: {
        runSystemTool,
        resolveManagedInstallable: async () => ({
          ok: false,
          errorMessage: 'localharness unavailable',
        }),
      },
    });

    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      env: { SAFE_TEST_ENV: 'kept' },
    }));
    expect(result).toEqual({ decision: 'allow' });
    await fixture.dispose();
  });
});
