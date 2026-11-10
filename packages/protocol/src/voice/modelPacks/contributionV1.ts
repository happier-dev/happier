import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

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

export const VoiceModelPackLocalIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(128), z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Voice model-pack ids must be filesystem-independent local identifiers.')));
const SemverPrereleaseIdentifier = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const SemverSchema = lazyZodSchema(() => z.string().check(z.trim(), z.regex(new RegExp(
    `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)`
      + `(?:-${SemverPrereleaseIdentifier}(?:\\.${SemverPrereleaseIdentifier})*)?`
      + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
  ), 'Voice model-pack versions must be valid semver versions.')));
const Sha256HexSchema = lazyZodSchema(() => z.pipe(z.string().check(z.regex(/^[0-9a-f]{64}$/i)), z.transform((value) => value.toLowerCase())));

function secureHttpsUrlSchema(label: string): z.ZodMiniType<string> {
  return z.string().check(z.minLength(1), z.maxLength(2048), z.superRefine((raw, ctx) => {
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
  }));
}

function uniqueArraySchema<T extends z.ZodMiniType>(schema: T, label: string) {
  return z.array(schema).check(z.refine((values) => new Set(values).size === values.length, `${label} must be unique.`));
}

const VoiceModelPackVoiceCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({
  id: VoiceModelPackLocalIdV1Schema,
  title: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  subtitle: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  sid: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(0x7fff_ffff))),
}));

function rejectDuplicateVoiceIds(
  voices: readonly Readonly<{ id: string }>[] | undefined,
  ctx: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, voice] of (voices ?? []).entries()) {
    if (seen.has(voice.id)) {
      ctx.addIssue({ code: 'custom', path: ['voices', index, 'id'], message: 'Voice ids must be unique.' });
    }
    seen.add(voice.id);
  }
}

export const VoiceModelPackExecutionHostV1Schema = lazyZodSchema(() => z.enum(['daemon', 'native_device']));
export type VoiceModelPackExecutionHostV1 = z.infer<typeof VoiceModelPackExecutionHostV1Schema>;

const VoiceModelPackRuntimeCommonV1Schema = {
  abiVersion: z.number().check(z.int(), z.positive(), z.maximum(0x7fff_ffff)),
  minHostVersion: SemverSchema,
  platforms: uniqueArraySchema(z.enum(['darwin', 'linux', 'win32', 'ios', 'android']), 'Runtime platforms').check(z.minLength(1), z.maxLength(5)),
  architectures: uniqueArraySchema(z.enum(['arm64', 'x64']), 'Runtime architectures').check(z.minLength(1), z.maxLength(2)),
} as const;

export const VoiceModelPackRuntimeV1Schema = lazyZodSchema(() => z.discriminatedUnion('family', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceModelPackTransducerArtifactContractV1Schema, {
    ...VoiceModelPackRuntimeCommonV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceModelPackKokoroArtifactContractV1Schema, {
    ...VoiceModelPackRuntimeCommonV1Schema,
  })),
]));
export type VoiceModelPackRuntimeV1 = z.infer<typeof VoiceModelPackRuntimeV1Schema>;

export const VoiceModelPackLicenseV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  title: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  url: secureHttpsUrlSchema('Voice model-pack license URL'),
  requiresAcceptance: z.boolean(),
  /** Exact bounded terms rendered by the host before a consent-gated install. */
  text: z.optional(z.string().check(z.minLength(1), z.maxLength(128 * 1024))),
}).check(z.superRefine((license, ctx) => {
  if (license.requiresAcceptance && !license.text) {
    ctx.addIssue({
      code: 'custom',
      path: ['text'],
      message: 'A license that requires acceptance must include the exact reviewable text.',
    });
  }
})));
export type VoiceModelPackLicenseV1 = z.infer<typeof VoiceModelPackLicenseV1Schema>;

export const VoiceModelPackManifestV1Schema = lazyZodSchema(() => z.strictObject({
  schemaVersion: z.literal(1),
  kind: ModelPackKindSchema,
  model: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  version: SemverSchema,
  runtime: VoiceModelPackRuntimeV1Schema,
  provenance: z.strictObject({
    source: secureHttpsUrlSchema('Voice model-pack provenance URL'),
    publisher: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  }),
  license: VoiceModelPackLicenseV1Schema,
  supportArtifacts: z.optional(z.array(VoiceModelPackSupportArtifactV1Schema).check(z.maxLength(32))),
  voices: z.optional(z.array(VoiceModelPackVoiceCatalogEntryV1Schema).check(z.maxLength(512))),
  /** Explicit catalog default. Omitted manifests use the first declared voice. */
  defaultVoiceId: z.optional(VoiceModelPackLocalIdV1Schema),
  files: z.array(z.strictObject({
    path: z.string().check(z.minLength(1), z.maxLength(512)),
    url: secureHttpsUrlSchema('Voice model-pack file URL'),
    sha256: Sha256HexSchema,
    sizeBytes: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
  })).check(z.minLength(1), z.maxLength(VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1)),
}).check(z.superRefine((manifest, ctx) => {
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
})));
export type VoiceModelPackManifestV1 = z.infer<typeof VoiceModelPackManifestV1Schema>;

export const VoiceModelPackContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: VoiceModelPackLocalIdV1Schema,
  schemaVersion: z.literal(1),
  executionHosts: z.array(VoiceModelPackExecutionHostV1Schema).check(z.minLength(1), z.maxLength(2), z.refine((hosts) => new Set(hosts).size === hosts.length, 'Execution hosts must be unique.')),
  manifest: VoiceModelPackManifestV1Schema,
}));
export type VoiceModelPackContributionV1 = z.infer<typeof VoiceModelPackContributionV1Schema>;
