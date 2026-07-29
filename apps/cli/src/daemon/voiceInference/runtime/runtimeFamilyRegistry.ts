import { join } from 'node:path';

import {
  getModelPackCatalogEntry,
  resolveVoiceModelPackArtifactsV1,
  type ModelPackManifest,
  type ModelPackRuntimeFamily,
  type VoiceModelPackRuntimeV1,
  type VoiceModelPackSupportArtifactV1,
} from '@happier-dev/protocol';

import { createVoiceInferenceError } from '../voiceInferenceWorker.shared';

export type DaemonVoiceRuntimePackAdapter =
  | Readonly<{
      runtimeFamily: 'sherpa_zipformer_streaming';
      files: Readonly<{
        encoder: string;
        decoder: string;
        joiner: string;
        tokens: string;
      }>;
    }>
  | Readonly<{
      runtimeFamily: 'sherpa_parakeet_offline';
      files: Readonly<{
        encoder: string;
        decoder: string;
        joiner: string;
        tokens: string;
      }>;
    }>
  | Readonly<{
      runtimeFamily: 'sherpa_kokoro_offline';
      files: Readonly<{
        model: string;
        voices: string;
        tokens: string;
        dataDir: string;
      }>;
    }>;

const SUPPORTED_RUNTIME_FAMILIES: ReadonlySet<ModelPackRuntimeFamily> = new Set([
  'sherpa_zipformer_streaming',
  'sherpa_kokoro_offline',
]);

// An adapter can be implemented and exercised before it is safe to advertise
// as installable. Parakeet remains staged until its published manifest,
// cancellation semantics, and measured memory policy pass the W4.3 gates.
const IMPLEMENTED_RUNTIME_FAMILIES: ReadonlySet<ModelPackRuntimeFamily> = new Set([
  ...SUPPORTED_RUNTIME_FAMILIES,
  'sherpa_parakeet_offline',
]);

export function isDaemonVoiceRuntimeFamilySupported(runtimeFamily: ModelPackRuntimeFamily): boolean {
  return SUPPORTED_RUNTIME_FAMILIES.has(runtimeFamily);
}

/**
 * Assert that downloaded metadata can actually satisfy the selected packaged
 * runtime adapter. Runtime-family support alone is insufficient: accepting a
 * same-id manifest with another kind or without the adapter's declared
 * files would record an unusable pack as successfully installed.
 */
export function assertDaemonVoiceRuntimeManifestCompatible(
  packId: string,
  manifest: ModelPackManifest,
): void {
  const entry = getModelPackCatalogEntry(packId);
  if (!entry) {
    throw createVoiceInferenceError('internal_error', 'voice_inference_model_pack_manifest_incompatible');
  }
  if (
    !isDaemonVoiceRuntimeFamilySupported(entry.runtimeFamily)
    || manifest.packId !== entry.packId
    || manifest.kind !== entry.kind
  ) {
    throw createVoiceInferenceError('internal_error', 'voice_inference_model_pack_manifest_incompatible');
  }

  try {
    if (entry.runtimeFamily === 'sherpa_kokoro_offline') {
      resolveVoiceModelPackArtifactsV1({
        family: entry.runtimeFamily,
        artifacts: entry.runtimeArtifacts,
      }, manifest.files, entry.supportArtifacts);
    } else {
      resolveVoiceModelPackArtifactsV1({
        family: entry.runtimeFamily,
        artifacts: entry.runtimeArtifacts,
      }, manifest.files, entry.supportArtifacts);
    }
  } catch {
    throw createVoiceInferenceError('internal_error', 'voice_inference_model_pack_manifest_incompatible');
  }
}

/**
 * Resolve the daemon's executable adapter from the catalog's declared family
 * and semantic artifact roles. This is the sole packaged-daemon family
 * registry used by both installability projection and runtime loading.
 */
export function resolveDaemonVoiceRuntimePackAdapter(
  packId: string,
  packDir: string,
  manifest: Pick<ModelPackManifest, 'files'>,
  runtimeDescriptor?: VoiceModelPackRuntimeV1 | null,
  supportArtifacts?: readonly VoiceModelPackSupportArtifactV1[],
): DaemonVoiceRuntimePackAdapter | null {
  const entry = getModelPackCatalogEntry(packId);
  const runtime = runtimeDescriptor ?? (entry
    ? { family: entry.runtimeFamily, artifacts: entry.runtimeArtifacts }
    : null);
  const declaredSupportArtifacts = runtimeDescriptor ? supportArtifacts : entry?.supportArtifacts;
  if (!runtime || !IMPLEMENTED_RUNTIME_FAMILIES.has(runtime.family)) {
    return null;
  }

  let resolved: ReturnType<typeof resolveVoiceModelPackArtifactsV1>;
  try {
    resolved = runtimeDescriptor
      ? resolveVoiceModelPackArtifactsV1(runtimeDescriptor, manifest.files, declaredSupportArtifacts)
      : entry?.runtimeFamily === 'sherpa_kokoro_offline'
        ? resolveVoiceModelPackArtifactsV1({
            family: entry.runtimeFamily,
            artifacts: entry.runtimeArtifacts,
          }, manifest.files, declaredSupportArtifacts)
        : entry
          ? resolveVoiceModelPackArtifactsV1({
              family: entry.runtimeFamily,
              artifacts: entry.runtimeArtifacts,
            }, manifest.files, declaredSupportArtifacts)
          : (() => { throw new Error('voice_model_pack_runtime_missing'); })();
  } catch {
    return null;
  }

  if (
    runtime.family === 'sherpa_zipformer_streaming'
    || runtime.family === 'sherpa_parakeet_offline'
  ) {
    if (resolved.family === 'sherpa_kokoro_offline') {
      return null;
    }
    return {
      runtimeFamily: runtime.family,
      files: {
        encoder: join(packDir, resolved.files.encoder),
        decoder: join(packDir, resolved.files.decoder),
        joiner: join(packDir, resolved.files.joiner),
        tokens: join(packDir, resolved.files.tokens),
      },
    };
  }

  if (runtime.family !== 'sherpa_kokoro_offline') {
    return null;
  }

  if (resolved.family !== 'sherpa_kokoro_offline') {
    return null;
  }
  return {
    runtimeFamily: runtime.family,
    files: {
      model: join(packDir, resolved.files.model),
      voices: join(packDir, resolved.files.voices),
      tokens: join(packDir, resolved.files.tokens),
      dataDir: join(packDir, resolved.files.dataDir),
    },
  };
}
