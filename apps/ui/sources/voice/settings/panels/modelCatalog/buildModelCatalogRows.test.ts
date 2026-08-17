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
    pluginIdentity: null,
    kind: entry?.kind ?? 'stt_sherpa',
    model: entry?.model ?? packId,
    version: null,
    executionSupport: ['daemon'],
    runtimeFamily: entry?.runtimeFamily ?? null,
    runtimeSupported: true,
    installState: 'not_installed',
    progress: null,
    lastError: null,
    updatedAtMs: 0,
    ...overrides,
  };
}

describe('buildModelCatalogRows', () => {
  it('omits uninstalled packs whose runtime family the daemon does not support', () => {
    const unsupportedPack = listModelPackCatalogEntries('stt_sherpa')
      .find((entry) => entry.runtimeFamily === 'sherpa_parakeet_offline')!;
    const result = buildModelCatalogRows({
      statuses: [status(unsupportedPack.packId, { runtimeSupported: false })],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    });

    expect(result.stt.some((row) => row.packId === unsupportedPack.packId)).toBe(false);
  });

  it('keeps an installed or selected unsupported pack visible as a disabled recovery row', () => {
    const unsupportedPack = listModelPackCatalogEntries('stt_sherpa')
      .find((entry) => entry.runtimeFamily === 'sherpa_parakeet_offline')!;
    const installed = buildModelCatalogRows({
      statuses: [status(unsupportedPack.packId, {
        installState: 'installed',
        runtimeSupported: false,
      })],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    }).stt.find((row) => row.packId === unsupportedPack.packId)!;
    expect(installed).toMatchObject({
      state: 'unsupported',
      canInstall: false,
      canRemove: true,
    });

    const selected = buildModelCatalogRows({
      statuses: [status(unsupportedPack.packId, { runtimeSupported: false })],
      selectedSttPackId: unsupportedPack.packId,
      selectedTtsPackId: null,
    }).stt.find((row) => row.packId === unsupportedPack.packId)!;
    expect(selected).toMatchObject({
      state: 'unsupported',
      isDefault: true,
      canInstall: false,
      canRemove: false,
    });
  });

  it('advertises only published built-in packs during normal catalog discovery', () => {
    const result = buildModelCatalogRows({ statuses: [], selectedSttPackId: null, selectedTtsPackId: null });
    const catalogSttIds = listModelPackCatalogEntries('stt_sherpa')
      .filter((entry) => entry.publicationStatus === 'published')
      .map((entry) => entry.packId)
      .sort();
    const catalogTtsIds = listModelPackCatalogEntries('tts_sherpa')
      .filter((entry) => entry.publicationStatus === 'published')
      .map((entry) => entry.packId)
      .sort();
    expect(result.stt.map((row) => row.packId).sort()).toEqual(catalogSttIds);
    expect(result.tts.map((row) => row.packId).sort()).toEqual(catalogTtsIds);
  });

  it('keeps installed or selected unavailable built-ins only as inert recovery rows', () => {
    const unavailablePack = listModelPackCatalogEntries('tts_sherpa')
      .find((entry) => entry.publicationStatus === 'unavailable')!;

    const installed = buildModelCatalogRows({
      statuses: [status(unavailablePack.packId, {
        installState: 'installed',
        runtimeSupported: true,
      })],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    }).tts.find((row) => row.packId === unavailablePack.packId);
    expect(installed).toMatchObject({
      state: 'unsupported',
      canInstall: false,
      canRemove: true,
      isDefault: false,
    });

    const selected = buildModelCatalogRows({
      statuses: [status(unavailablePack.packId, {
        installState: 'not_installed',
        runtimeSupported: true,
      })],
      selectedSttPackId: null,
      selectedTtsPackId: unavailablePack.packId,
    }).tts.find((row) => row.packId === unavailablePack.packId);
    expect(selected).toMatchObject({
      state: 'unsupported',
      canInstall: false,
      canRemove: false,
      isDefault: true,
    });
  });

  it('adds an external plugin pack from the effective selected-host daemon catalog', () => {
    const packId = 'acme.speech/english-small';
    const licenseReview = {
      pluginId: 'acme.speech',
      packId: 'english-small',
      pluginVersion: '1.2.3',
      packVersion: '2026.7.0',
      licenseId: 'acme-model-license-v1',
      licenseTitle: 'Acme model license',
      licenseText: 'Review these exact model terms.',
      licenseSourceUrl: 'https://example.com/licenses/acme-v1',
      licenseTextDigest: `sha256:${'a'.repeat(64)}`,
      artifactBinding: { kind: 'sourceIntegrity', integrity: `sha256:${'b'.repeat(64)}` },
      accepted: false,
    } as const;
    const row = buildModelCatalogRows({
      statuses: [status(packId, {
        pluginIdentity: { pluginId: 'acme.speech', packId: 'english-small' },
        kind: 'stt_sherpa',
        model: 'acme-english-small',
        version: '2026.7.0',
        runtimeFamily: 'sherpa_zipformer_streaming',
        runtimeSupported: true,
        licenseReview,
      })],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    }).stt.find((candidate) => candidate.packId === packId);

    expect(row).toMatchObject({
      packId,
      sourcePluginId: 'acme.speech',
      state: 'not_installed',
      canInstall: true,
      licenseReview,
    });
  });

  it('reports not_installed when the daemon projects a supported published absent pack', () => {
    const statuses = listModelPackCatalogEntries()
      .filter((entry) => entry.publicationStatus === 'published')
      .map((entry) => status(entry.packId));
    const result = buildModelCatalogRows({ statuses, selectedSttPackId: null, selectedTtsPackId: null });
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
      statuses: [status(sttPack, {
        installState: 'installed',
        runtimeState: 'ready',
        loadedArtifactBytes: 2048,
      })],
      selectedSttPackId: null,
      selectedTtsPackId: null,
    }).stt.find((candidate) => candidate.packId === sttPack)!;
    expect(ready.state).toBe('ready');
    expect(ready.loadedArtifactBytes).toBe(2048);
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

  it('keeps retry and remove available after a failed reinstall retains live bytes', () => {
    const sttPack = listModelPackCatalogEntries('stt_sherpa')[0]!.packId;
    const row = buildModelCatalogRows({
      statuses: [status(sttPack, {
        installState: 'installed',
        lastError: 'model_pack_sha256_mismatch',
      })],
      selectedSttPackId: sttPack,
      selectedTtsPackId: null,
    }).stt.find((candidate) => candidate.packId === sttPack)!;

    expect(row).toMatchObject({
      state: 'error',
      lastError: 'model_pack_sha256_mismatch',
      isDefault: true,
      canInstall: true,
      canRemove: true,
    });
  });

  it('keeps an incompatible retained pack removable without offering an invalid retry', () => {
    const unsupportedPack = listModelPackCatalogEntries('stt_sherpa')
      .find((entry) => entry.runtimeFamily === 'sherpa_parakeet_offline')!;
    const selectedNeighbor = getDefaultModelPackId('stt_sherpa')!;
    const result = buildModelCatalogRows({
      statuses: [
        status(unsupportedPack.packId, {
          installState: 'installed',
          runtimeSupported: false,
          lastError: 'previous_reinstall_failed',
        }),
        status(selectedNeighbor),
      ],
      selectedSttPackId: selectedNeighbor,
      selectedTtsPackId: null,
    });
    const retained = result.stt.find((candidate) => candidate.packId === unsupportedPack.packId)!;
    const neighbor = result.stt.find((candidate) => candidate.packId === selectedNeighbor)!;

    expect(retained).toMatchObject({
      state: 'unsupported',
      lastError: 'previous_reinstall_failed',
      isDefault: false,
      canInstall: false,
      canRemove: true,
    });
    expect(neighbor).toMatchObject({
      isDefault: true,
      canInstall: true,
      canRemove: false,
    });
  });

  it('keeps a failed install visible after the daemon reports the pack absent', () => {
    const sttPack = listModelPackCatalogEntries('stt_sherpa')[0]!.packId;
    const row = buildModelCatalogRows({
      statuses: [status(sttPack, { installState: 'not_installed' })],
      actionError: { packId: sttPack, operation: 'install' },
      selectedSttPackId: null,
      selectedTtsPackId: null,
    }).stt.find((candidate) => candidate.packId === sttPack)!;

    expect(row.state).toBe('error');
    expect(row.canInstall).toBe(true);
    expect(row.canRemove).toBe(false);
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

  it('marks the exact selected pack as default per kind', () => {
    const defaultStt = getDefaultModelPackId('stt_sherpa')!;
    const result = buildModelCatalogRows({
      statuses: [],
      selectedSttPackId: defaultStt,
      selectedTtsPackId: 'kokoro-82m-v1.0-onnx-q8-wasm',
    });
    const sttRow = result.stt.find((row) => row.packId === defaultStt)!;
    expect(sttRow.isDefault).toBe(true);
    const ttsDefault = result.tts.find((row) => row.isDefault);
    expect(ttsDefault?.packId).toBe(getDefaultModelPackId('tts_sherpa'));
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
