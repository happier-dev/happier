import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createMuseMspProcessFixture, MUSE_MSP_PLAYBACK_SCRIPT, readMuseLoginRecording } from './testkit/mspProcess.js';
import { MUSE_MSP_LAUNCH, openMuseMsp } from './msp.js';

import { createMuseCatalog, MUSE_PREFLIGHT_SESSION_CONTROLS } from './catalog.js';

// The catalog is a read: a launch with no explicit model preserves the native
// default, while an explicit selection must never silently choose another row.

async function openCatalog(recording?: JsonValue) {
  const { launch, ...boundary } = await createMuseMspProcessFixture({ recording });
  const exec = createStablePluginExecService({ signal: new AbortController().signal,
    isOccurrenceCurrent: () => true, ...boundary });
  const msp = await openMuseMsp({ exec, launch });
  return { msp, catalog: createMuseCatalog(msp.client) };
}

async function recordingWithCatalog(result: JsonValue): Promise<JsonValue> {
  const recording = await readMuseLoginRecording();
  const replace = (value: JsonValue): JsonValue => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(replace);
    const response = value.result;
    if (response && typeof response === 'object' && !Array.isArray(response) && Array.isArray(response.models)) {
      return { ...value, result };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
  };
  return replace(recording);
}

describe('Muse native model catalog', () => {
  it('offers native models through the real host pre-Session catalog front door', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-muse-model-preflight-'));
    const script = join(directory, 'playback.cjs');
    const recording = await readMuseLoginRecording();
    await writeFile(script, `process.env.MUSE_TEST_RECORDING = ${JSON.stringify(JSON.stringify(recording))};\n${MUSE_MSP_PLAYBACK_SCRIPT}`);
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const executable = writeExecutableShimSync({ dir: directory,
      fileName: process.platform === 'win32' ? 'muse.cmd' : 'muse',
      contents: process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    });
    const entry = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'muse',
      systemTools: [{ id: 'muse-cli', title: 'Muse native playback', executableNames: [executable] }],
      preflightSessionControls: MUSE_PREFLIGHT_SESSION_CONTROLS,
      retirementSignal: new AbortController().signal, isCurrent: () => true,
    });
    try {
      const adapter = await entry.getPreflightSessionControlsProbeAdapter?.();
      const models = await adapter?.probeModelsRaw?.({ cwd: directory, timeoutMs: 10_000,
        env: { ...MUSE_MSP_LAUNCH.env } });
      expect(models).toMatchObject([
        { id: 'meta/muse-wonder-1.0' }, { id: 'meta/muse-spark-1.3' }, { id: 'meta/muse-spark-1.2' },
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('offers the actual model-dependent effort choices and preserves equal observations', async () => {
    const { msp, catalog } = await openCatalog();
    try {
      expect(catalog.read().models).toBeNull();
      const publications: unknown[] = [];
      catalog.subscribe(snapshot => { publications.push(snapshot); });
      const first = await catalog.refresh();
      expect(first.models?.map(model => model.id)).toEqual([
        'meta/muse-wonder-1.0', 'meta/muse-spark-1.3', 'meta/muse-spark-1.2',
      ]);
      expect(first.models?.[0].modelOptions?.[0]).toMatchObject({
        id: 'reasoning_effort', currentValue: 'max',
        options: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, name: value })),
      });
      expect(first.models?.[2].modelOptions?.[0].options?.map(option => option.value)).toEqual([
        'minimal', 'low', 'medium', 'high', 'xhigh',
      ]);
      expect(catalog.resolveModelSelection()).toEqual({ status: 'nativeDefault' });
      expect(catalog.resolveModelSelection('default')).toMatchObject({
        status: 'selected', id: 'meta/muse-wonder-1.0', providerId: 'meta', modelId: 'muse-wonder-1.0',
      });
      expect(catalog.resolveModelSelection('unknown/model')).toEqual({ status: 'unavailable', reason: 'model_unavailable' });
      expect(await catalog.refresh()).toBe(first);
      expect(publications).toHaveLength(1);
      const selection = catalog.resolveModelSelection('default');
      if (selection.status !== 'selected') throw new Error('Captured native default must be selectable');
      await msp.command('session/start', {
        workspaceRoot: '/selected/worktree', providerId: selection.providerId, modelId: selection.modelId,
      });
      const hostPublications = createNativeAgentSessionPublications({ agentId: 'muse', session: null,
        signal: new AbortController().signal, isCurrent: () => true, supportsInFlightSteer: false });
      const binding = hostPublications.services.models.bind(catalog);
      try {
        catalog.applyCurrentModel(selection);
        const effective = hostPublications.modelsSource.read();
        expect(effective.models?.[0].modelOptions?.[0].currentValue).toBeNull();
        await catalog.refresh({ sessionId: '01a1bf87-da7f-7ce0-a4ff-bab34925049f' });
        expect(hostPublications.modelsSource.read()).toBe(effective);
        expect(first.models?.[0].modelOptions?.[0].currentValue).toBe('max');
      } finally { binding.dispose(); hostPublications.dispose(); }
      expect(await msp.client.request('fixture/inspect')).toMatchObject({
        modelSelections: [{ providerId: 'meta', modelId: 'muse-wonder-1.0' }],
        requests: ['initialize', 'initialized', 'model/list', 'model/list', 'session/start', 'model/list', 'fixture/inspect'],
      });
    } finally { await msp.dispose(); }
  });

  it('keeps an answered-empty catalog empty and refuses an explicit unavailable default', async () => {
    // Schema-derived boundary vector: the native recording contains models.
    const { msp, catalog } = await openCatalog(await recordingWithCatalog({ models: [] }));
    try {
      expect(catalog.resolveModelSelection('default')).toEqual({ status: 'unavailable', reason: 'default_model_unavailable' });
      expect(await catalog.refresh()).toEqual({ models: [], currentModelId: null });
      expect(catalog.resolveModelSelection()).toEqual({ status: 'nativeDefault' });
      expect(catalog.resolveModelSelection('default')).toEqual({ status: 'unavailable', reason: 'default_model_unavailable' });
      expect(catalog.resolveModelSelection('meta/muse-wonder-1.0')).toEqual({ status: 'unavailable', reason: 'model_unavailable' });
    } finally { await msp.dispose(); }
  });

  it('preserves all key-route contributor choices, their native disclosure, and the exact selected model id', async () => {
    // Captured Muse 1.4.14 key-route model/list; no live credential is used.
    const recording = JSON.parse(await readFile(new URL('./testkit/fixtures/key-only.json', import.meta.url), 'utf8')) as JsonValue;
    const { msp, catalog } = await openCatalog(recording);
    try {
      const snapshot = await catalog.refresh();
      expect(snapshot.models?.map(model => model.id)).toEqual([
        'meta/muse-wonder-1.0', 'meta/muse-wonder-1.0-contributor',
        'meta/muse-spark-1.3', 'meta/muse-spark-1.3-contributor',
        'meta/muse-spark-1.2', 'meta/muse-spark-1.2-contributor',
      ]);
      expect(snapshot.models?.[1]).toMatchObject({
        name: 'muse-wonder-1.0-contributor',
        description: 'Your content, including inter-session messages, may be used for product improvement.',
      });
      expect(catalog.resolveModelSelection('default')).toMatchObject({
        status: 'selected', id: 'meta/muse-wonder-1.0-contributor', modelId: 'muse-wonder-1.0-contributor',
      });
      expect(catalog.resolveModelSelection('meta/muse-spark-1.2-contributor')).toMatchObject({
        status: 'selected', providerId: 'meta', modelId: 'muse-spark-1.2-contributor',
      });
      for (const modelId of ['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor', 'muse-spark-1.2']) {
        expect(catalog.resolveModelSelection(modelId)).toMatchObject({ status: 'selected', providerId: 'meta', modelId });
      }
      const selection = catalog.resolveModelSelection('muse-spark-1.2-contributor');
      if (selection.status !== 'selected') throw new Error('Captured contributor model must be selectable');
      await msp.command('session/start', {
        workspaceRoot: '/selected/worktree', providerId: selection.providerId, modelId: selection.modelId,
      });
      expect(await msp.client.request('fixture/inspect')).toMatchObject({
        modelSelections: [{ providerId: 'meta', modelId: 'muse-spark-1.2-contributor' }],
        requests: ['initialize', 'initialized', 'model/list', 'session/start', 'fixture/inspect'],
      });
    } finally { await msp.dispose(); }
  });

  it('refuses ambiguous native ids while preserving exact qualified selection', async () => {
    const { msp, catalog } = await openCatalog(await recordingWithCatalog({ models: [
      { providerId: 'first', modelId: 'shared' }, { providerId: 'second', modelId: 'shared' },
    ] }));
    try {
      await catalog.refresh();
      expect(catalog.resolveModelSelection('shared')).toEqual({ status: 'unavailable', reason: 'model_unavailable' });
      expect(catalog.resolveModelSelection('second/shared')).toMatchObject({ status: 'selected', providerId: 'second', modelId: 'shared' });
    } finally { await msp.dispose(); }
  });

  it('retains an unobserved source when the native response is malformed', async () => {
    // Schema-derived invalid response; it must not become an observed empty list.
    const { msp, catalog } = await openCatalog(await recordingWithCatalog({}));
    try {
      await expect(catalog.refresh()).rejects.toMatchObject({ data: { code: 'PLUGIN_EXEC_PROTOCOL_ERROR', details: { phase: 'model/list' } } });
      expect(catalog.read()).toEqual({ models: null });
    } finally { await msp.dispose(); }
  });
});
