import { AIBackendProfileSchema } from './backendProfileSchema.js';
import {
  projectHistoricalBuiltInAiLaunchProfileV1,
  type HistoricalAiBackendProfileV1,
} from './historicalCompatibilityV1.js';
import { LaunchProfileV2Schema, type LaunchProfileV2 } from './v2/schema.js';
import type { ProviderSettingsMigrationStateV1 } from '../providers/settings/v1.js';

export type AiLaunchProfile = HistoricalAiBackendProfileV1 | LaunchProfileV2;

export function isLaunchProfileV2(profile: AiLaunchProfile): profile is LaunchProfileV2 {
  return 'v' in profile && profile.v === 2;
}

export type AiLaunchProfileCollectionEntry =
  | Readonly<{ kind: 'legacy'; profile: HistoricalAiBackendProfileV1; raw: unknown }>
  | Readonly<{ kind: 'slim'; profile: LaunchProfileV2; raw: unknown }>
  | Readonly<{ kind: 'opaque'; raw: unknown }>;

export type AiLaunchProfileReadDiagnostic = Readonly<{
  index: number;
  reason: 'future_version' | 'malformed';
}>;

export type AiLaunchProfileCollectionReadResult = Readonly<{
  raw: unknown;
  entries: readonly AiLaunchProfileCollectionEntry[];
  diagnostics: readonly AiLaunchProfileReadDiagnostic[];
}>;

// Historical built-ins are not guaranteed to be persisted in `profiles`, but their
// SavedSecret bindings can exist before the daemon-owned atomic migration runs.
// Keep this compatibility inventory in the protocol reader rather than duplicating
// provider/profile knowledge in UI pruning code.
const LEGACY_AI_LAUNCH_BUILT_IN_PROFILE_IDS_V1 = new Set([
  'anthropic',
  'codex',
  'gemini',
  'deepseek',
  'zai',
  'openai',
  'azure-openai',
  'gemini-api-key',
  'gemini-vertex',
]);

export function isHistoricalBuiltInAiLaunchProfileIdV1(profileId: string): boolean {
  return LEGACY_AI_LAUNCH_BUILT_IN_PROFILE_IDS_V1.has(profileId);
}

export function readAiLaunchProfileCollection(raw: unknown): AiLaunchProfileCollectionReadResult {
  if (!Array.isArray(raw)) return { raw, entries: [], diagnostics: [] };
  const entries: AiLaunchProfileCollectionEntry[] = [];
  const diagnostics: AiLaunchProfileReadDiagnostic[] = [];
  raw.forEach((entry, index) => {
    const slim = LaunchProfileV2Schema.safeParse(entry);
    if (slim.success) {
      entries.push({ kind: 'slim', profile: slim.data, raw: entry });
      return;
    }
    const legacy = AIBackendProfileSchema.safeParse(entry);
    if (legacy.success) {
      entries.push({
        kind: 'legacy',
        profile: projectHistoricalBuiltInAiLaunchProfileV1(legacy.data),
        raw: entry,
      });
      return;
    }
    const version = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Reflect.get(entry, 'v')
      : undefined;
    diagnostics.push({ index, reason: typeof version === 'number' && version > 2 ? 'future_version' : 'malformed' });
    entries.push({ kind: 'opaque', raw: entry });
  });
  return { raw, entries, diagnostics };
}

function readOwnStringId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = Reflect.get(raw, 'id');
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Fail-safe UI pruning predicate. Migration completion is intentionally not a
 * deletion signal here: the daemon's whole-account CAS transform owns removal
 * of migrated bindings in the same atomic write as the provider connection.
 */
export function shouldPreserveLegacyAiLaunchProfileBindingV1(input: Readonly<{
  profileId: string;
  collection: AiLaunchProfileCollectionReadResult;
  migration?: ProviderSettingsMigrationStateV1 | null;
}>): boolean {
  if (LEGACY_AI_LAUNCH_BUILT_IN_PROFILE_IDS_V1.has(input.profileId)) return true;
  if (input.migration?.pendingCustomProfileIds.includes(input.profileId)) return true;
  return input.collection.entries.some((entry) => readOwnStringId(entry.raw) === input.profileId);
}
