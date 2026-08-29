import { z } from 'zod';

import { classifyProviderHostnameSyntax } from '../../providers/safety/locality.js';
import { normalizeProviderEndpointUrlSyntax } from '../../providers/safety/url.js';
import { ModelPackKindSchema } from './manifest.js';
import { assertManifestPathsSafe } from './pathSafety.js';
import {
  VoiceModelPackKokoroArtifactContractV1Schema,
  VoiceModelPackSupportArtifactV1Schema,
  VoiceModelPackTransducerArtifactContractV1Schema,
  resolveVoiceModelPackArtifactsV1,
} from './artifactRolesV1.js';

export {
  VoiceModelPackArtifactContractV1Schema,
  VoiceModelPackDirectoryArtifactV1Schema,
  VoiceModelPackFileArtifactV1Schema,
  VoiceModelPackKokoroArtifactsV1Schema,
  VoiceModelPackSupportArtifactKindV1Schema,
  VoiceModelPackSupportArtifactV1Schema,
  VoiceModelPackTransducerArtifactsV1Schema,
} from './artifactRolesV1.js';
export type {
  VoiceModelPackDirectoryArtifactV1,
  VoiceModelPackFileArtifactV1,
  VoiceModelPackKokoroArtifactsV1,
  VoiceModelPackTransducerArtifactsV1,
  VoiceModelPackSupportArtifactKindV1,
  VoiceModelPackSupportArtifactV1,
} from './artifactRolesV1.js';

/**
 * The canonical Kokoro q8 graph contains 362 exact files. Keep a narrow,
 * explicit 22-file allowance for graph/support-file evolution without opening
 * public declarations or installers to an unbounded file fan-out.
 */
export const VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1 = 384;
export const VOICE_MODEL_PACK_CONTRIBUTION_MAX_COMPONENT_BYTES_V1 = 1024;

export const VoiceModelPackLocalIdV1Schema = z.string().trim().min(1).max(128).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  'Voice model-pack ids must be filesystem-independent local identifiers.',
);
const SemverPrereleaseIdentifier = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const SemverSchema = z.string().trim().regex(
  new RegExp(
    `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)`
      + `(?:-${SemverPrereleaseIdentifier}(?:\\.${SemverPrereleaseIdentifier})*)?`
      + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
  ),
  'Voice model-pack versions must be valid semver versions.',
);
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/i).transform((value) => value.toLowerCase());

function secureHttpsUrlSchema(label: string): z.ZodType<string> {
  return z.string().min(1).max(2048).superRefine((raw, ctx) => {
    try {
      const endpoint = normalizeProviderEndpointUrlSyntax(raw);
      if (endpoint.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', message: `${label} must use HTTPS.` });
      }
      if (
        (endpoint.literalAddress && endpoint.literalAddress.locality !== 'public')
        || (!endpoint.literalAddress && classifyProviderHostnameSyntax(endpoint.hostname) === 'loopback')
      ) {
        ctx.addIssue({ code: 'custom', message: `${label} must use a public destination.` });
      }
    } catch {
      ctx.addIssue({ code: 'custom', message: `${label} must be a safe absolute URL without credentials.` });
    }
  });
}

function uniqueArraySchema<T extends z.ZodType>(schema: T, label: string) {
  return z.array(schema).refine(
    (values) => new Set(values).size === values.length,
    `${label} must be unique.`,
  );
}

const VoiceModelPackVoiceCatalogEntryV1Schema = z.object({
  id: VoiceModelPackLocalIdV1Schema,
  title: z.string().trim().min(1).max(256),
  subtitle: z.string().trim().min(1).max(512).optional(),
  sid: z.number().int().min(0).max(0x7fff_ffff).optional(),
}).strict();

function rejectDuplicateVoiceIds(
  voices: readonly Readonly<{ id: string }>[] | undefined,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, voice] of (voices ?? []).entries()) {
    if (seen.has(voice.id)) {
      ctx.addIssue({ code: 'custom', path: ['voices', index, 'id'], message: 'Voice ids must be unique.' });
    }
    seen.add(voice.id);
  }
}

export const VoiceModelPackExecutionHostV1Schema = z.enum(['daemon', 'native_device']);
export type VoiceModelPackExecutionHostV1 = z.infer<typeof VoiceModelPackExecutionHostV1Schema>;

const VoiceModelPackRuntimeCommonV1Schema = {
  abiVersion: z.number().int().positive().max(0x7fff_ffff),
  minHostVersion: SemverSchema,
  platforms: uniqueArraySchema(z.enum(['darwin', 'linux', 'win32', 'ios', 'android']), 'Runtime platforms').min(1).max(5),
  architectures: uniqueArraySchema(z.enum(['arm64', 'x64']), 'Runtime architectures').min(1).max(2),
} as const;

export const VoiceModelPackRuntimeV1Schema = z.discriminatedUnion('family', [
  VoiceModelPackTransducerArtifactContractV1Schema.extend({
    ...VoiceModelPackRuntimeCommonV1Schema,
  }).strict(),
  VoiceModelPackKokoroArtifactContractV1Schema.extend({
    ...VoiceModelPackRuntimeCommonV1Schema,
  }).strict(),
]);
export type VoiceModelPackRuntimeV1 = z.infer<typeof VoiceModelPackRuntimeV1Schema>;

export const VoiceModelPackLicenseV1Schema = z.object({
  id: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(256),
  url: secureHttpsUrlSchema('Voice model-pack license URL'),
  requiresAcceptance: z.boolean(),
  /** Exact bounded terms rendered by the host before a consent-gated install. */
  text: z.string().min(1).max(128 * 1024).optional(),
}).strict().superRefine((license, ctx) => {
  if (license.requiresAcceptance && !license.text) {
    ctx.addIssue({
      code: 'custom',
      path: ['text'],
      message: 'A license that requires acceptance must include the exact reviewable text.',
    });
  }
});
export type VoiceModelPackLicenseV1 = z.infer<typeof VoiceModelPackLicenseV1Schema>;

export const VoiceModelPackManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: ModelPackKindSchema,
  model: z.string().trim().min(1).max(256),
  version: SemverSchema,
  runtime: VoiceModelPackRuntimeV1Schema,
  provenance: z.object({
    source: secureHttpsUrlSchema('Voice model-pack provenance URL'),
    publisher: z.string().trim().min(1).max(256),
  }).strict(),
  license: VoiceModelPackLicenseV1Schema,
  supportArtifacts: z.array(VoiceModelPackSupportArtifactV1Schema).max(32).optional(),
  voices: z.array(VoiceModelPackVoiceCatalogEntryV1Schema).max(512).optional(),
  /** Explicit catalog default. Omitted manifests use the first declared voice. */
  defaultVoiceId: VoiceModelPackLocalIdV1Schema.optional(),
  files: z.array(z.object({
    path: z.string().min(1).max(512),
    url: secureHttpsUrlSchema('Voice model-pack file URL'),
    sha256: Sha256HexSchema,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict()).min(1).max(VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1),
}).strict().superRefine((manifest, ctx) => {
  const expectedKind = manifest.runtime.family === 'sherpa_kokoro_offline'
    ? 'tts_sherpa'
    : 'stt_sherpa';
  if (manifest.kind !== expectedKind) {
    ctx.addIssue({
      code: 'custom',
      path: ['kind'],
      message: `Runtime family '${manifest.runtime.family}' requires model-pack kind '${expectedKind}'.`,
    });
  }
  rejectDuplicateVoiceIds(manifest.voices, ctx);
  if (
    manifest.defaultVoiceId
    && !(manifest.voices ?? []).some((voice) => voice.id === manifest.defaultVoiceId)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultVoiceId'],
      message: 'The default voice must identify a declared voice.',
    });
  }
  try {
    assertManifestPathsSafe(manifest);
  } catch {
    ctx.addIssue({ code: 'custom', path: ['files'], message: 'Voice model-pack file paths must be unique safe relative paths.' });
  }
  try {
    resolveVoiceModelPackArtifactsV1(manifest.runtime, manifest.files, manifest.supportArtifacts);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      path: ['runtime', 'artifacts'],
      message: error instanceof Error ? error.message : 'voice_model_pack_artifact_mapping_invalid',
    });
  }
});
export type VoiceModelPackManifestV1 = z.infer<typeof VoiceModelPackManifestV1Schema>;

export const VoiceModelPackContributionV1Schema = z.object({
  id: VoiceModelPackLocalIdV1Schema,
  schemaVersion: z.literal(1),
  executionHosts: z.array(VoiceModelPackExecutionHostV1Schema).min(1).max(2)
    .refine((hosts) => new Set(hosts).size === hosts.length, 'Execution hosts must be unique.'),
  manifest: VoiceModelPackManifestV1Schema,
}).strict();
export type VoiceModelPackContributionV1 = z.infer<typeof VoiceModelPackContributionV1Schema>;
