import { describe, expect, it } from 'vitest';

import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol';
import {
  getDefaultModelPackId,
  listModelPackCatalogEntries,
} from '@happier-dev/protocol';

import { buildModelCatalogRows } from './buildModelCatalogRows';

function status(
  packId: string,
  overrides: Partial<DaemonVoiceInferenceModelStatus> = {},
): DaemonVoiceInferenceModelStatus {
  const entry = listModelPackCatalogEntries().find((candidate) => candidate.packId === packId);
  return {
    packId,
    kind: entry?.kind ?? 'stt_sherpa',
    model: entry?.model ?? packId,
    version: null,
    executionSupport: ['daemon'],
    installState: 'not_installed',
    progress: null,
    lastError: null,
    updatedAtMs: 0,
    ...overrides,
  };
}

describe('buildModelCatalogRows', () => {
  it('groups catalog entries into stt and tts sections covering every catalog pack', () => {
    const result = buildModelCatalogRows({ statuses: [], selectedSttPackId: null, selectedTtsPackId: null });
    const catalogSttIds = listModelPackCatalogEntries('stt_sherpa').map((entry) => entry.packId).sort();
    const catalogTtsIds = listModelPackCatalogEntries('tts_sherpa').map((entry) => entry.packId).sort();
    expect(result.stt.map((row) => row.packId).sort()).toEqual(catalogSttIds);
    expect(result.tts.map((row) => row.packId).sort()).toEqual(catalogTtsIds);
  });

  it('reports not_installed when the daemon has no status for a pack', () => {
    const result = buildModelCatalogRows({ statuses: [], selectedSttPackId: null, selectedTtsPackId: null });
    for (const row of [...result.stt, ...result.tts]) {
      expect(row.state).toBe('not_installed');
      expect(row.canInstall).toBe(true);
      expect(row.canRemove).toBe(false);
    }
  });

  it('maps installing install-state to a downloading row with progress', () => {
    const sttPack = listModelPackCatalogEntries('stt_sherpa')[0]!.packId;
    const result = buildModelCatalogRows({
      statuses: [
        status(sttPack, {
          installState: 'installing',
          progress: { phase: 'downloading', progress: 0.42, bytesDownloaded: 42, totalBytes: 100, message: null },
        }),
      ],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    });
    const row = result.stt.find((candidate) => candidate.packId === sttPack)!;
    expect(row.state).toBe('downloading');
    expect(row.progress).toBe(0.42);
    expect(row.canInstall).toBe(false);
    expect(row.canRemove).toBe(false);
  });

  it('prefers readiness runtimeState over installed when the pack is loaded', () => {
    const sttPack = listModelPackCatalogEntries('stt_sherpa')[0]!.packId;
    const ready = buildModelCatalogRows({
      statuses: [status(sttPack, { installState: 'installed', runtimeState: 'ready', residentMemoryBytes: 2048 })],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    }).stt.find((candidate) => candidate.packId === sttPack)!;
    expect(ready.state).toBe('ready');
    expect(ready.residentMemoryBytes).toBe(2048);
    expect(ready.canRemove).toBe(true);

    const warming = buildModelCatalogRows({
      statuses: [status(sttPack, { installState: 'installed', runtimeState: 'warming' })],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    }).stt.find((candidate) => candidate.packId === sttPack)!;
    expect(warming.state).toBe('warming');

    const evicted = buildModelCatalogRows({
      statuses: [status(sttPack, { installState: 'installed', runtimeState: 'evicted' })],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    }).stt.find((candidate) => candidate.packId === sttPack)!;
    expect(evicted.state).toBe('evicted');
  });

  it('maps installed pack with cold runtimeState to installed', () => {
    const sttPack = listModelPackCatalogEntries('stt_sherpa')[0]!.packId;
    const row = buildModelCatalogRows({
      statuses: [status(sttPack, { installState: 'installed', runtimeState: 'cold' })],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    }).stt.find((candidate) => candidate.packId === sttPack)!;
    expect(row.state).toBe('installed');
  });

  it('maps error install-state to an error row that can be retried', () => {
    const sttPack = listModelPackCatalogEntries('stt_sherpa')[0]!.packId;
    const row = buildModelCatalogRows({
      statuses: [status(sttPack, { installState: 'error', lastError: 'boom' })],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    }).stt.find((candidate) => candidate.packId === sttPack)!;
    expect(row.state).toBe('error');
    expect(row.lastError).toBe('boom');
    expect(row.canInstall).toBe(true);
  });

  it('maps every row to an uninstallable unknown state when the daemon status is unavailable', () => {
    // When the status RPC fails the daemon health is unknown. Rows must NOT be
    // installable so an install can never fire against an unknown daemon.
    const result = buildModelCatalogRows({
      statuses: [],
      statusUnavailable: true,
      selectedSttPackId: null,
      selectedTtsPackId: null,
    });
    expect([...result.stt, ...result.tts].length).toBeGreaterThan(0);
    for (const row of [...result.stt, ...result.tts]) {
      expect(row.state).toBe('unknown');
      expect(row.canInstall).toBe(false);
      expect(row.canRemove).toBe(false);
    }
  });

  it('marks the selected pack as default per kind, resolving legacy ids', () => {
    const defaultStt = getDefaultModelPackId('stt_sherpa')!;
    const result = buildModelCatalogRows({
      statuses: [],
      // legacy kokoro wasm id should resolve to the canonical tts default
      selectedSttPackId: defaultStt,
      selectedTtsPackId: 'kokoro-82m-v1.0-onnx-q8-wasm',
    });
    const sttRow = result.stt.find((row) => row.packId === defaultStt)!;
    expect(sttRow.isDefault).toBe(true);
    const ttsDefault = result.tts.find((row) => row.isDefault);
    expect(ttsDefault?.packId).toBe('kokoro-tts-en-v1');
    // Exactly one default per kind.
    expect(result.stt.filter((row) => row.isDefault)).toHaveLength(1);
    expect(result.tts.filter((row) => row.isDefault)).toHaveLength(1);
  });

  it('falls back to the catalog default when no selection is stored', () => {
    const result = buildModelCatalogRows({ statuses: [], selectedSttPackId: null, selectedTtsPackId: null });
    expect(result.stt.find((row) => row.isDefault)?.packId).toBe(getDefaultModelPackId('stt_sherpa'));
    expect(result.tts.find((row) => row.isDefault)?.packId).toBe(getDefaultModelPackId('tts_sherpa'));
  });

  it('exposes a stable display name derived from the catalog model', () => {
    const result = buildModelCatalogRows({ statuses: [], selectedSttPackId: null, selectedTtsPackId: null });
    for (const row of [...result.stt, ...result.tts]) {
      expect(row.displayName.length).toBeGreaterThan(0);
    }
  });
});
