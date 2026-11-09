import { deriveRegistrySourceIdV1, readGitHubRepositoryV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import type { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import type { RegistryProvenanceV1 } from '@happier-dev/protocol/registries';
import type { RegistryUpdateTrackerV1 } from '../registryUpdateTracker';

/** The library owner remains the sole content/provenance/CAS writer. */
export function createSkillsUpdateTracker(input: Readonly<{
  execute: ReturnType<typeof createSkillActionExecuteV1>;
  signal?: AbortSignal;
}>): RegistryUpdateTrackerV1 {
  const record: RegistryUpdateTrackerV1['record'] = async changes => {
    for (const change of changes) {
      input.signal?.throwIfAborted();
      const current = await input.execute.recordRegistryUpstream(change.key, change.upstream, input.signal, change.provenance);
      if (!current || current.updatePolicy !== 'auto' || current.modified || current.upstream?.state !== 'update_available') continue;
      const result = await input.execute('skills.updates.apply', { skillId: current.skillId, expectedRevision: current.revision },
        { surface: 'cli' }, input.signal);
      SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.apply'].parse(result);
    }
  };
  return {
    kind: 'skill',
    async list(keys) {
      const items = await input.execute.listRegistryTrackedSkills(input.signal, keys);
      return items.flatMap(item => {
        if (item.provenance.kind === 'registry') return [{ key: item.skillId, provenance: item.provenance.registry,
          ...(item.upstream ? { upstream: item.upstream } : {}) }];
        if (item.provenance.kind === 'wellKnown') {
          const ref = item.provenance;
          const source: RegistrySourceDescriptorV1 = { id: `link:${deriveRegistrySourceIdV1(ref.indexUrl)}`, title: ref.indexUrl,
            format: 'skills-sh', kinds: ['skill'], url: ref.indexUrl, enabled: true, addedAt: item.createdAt,
            origin: { kind: 'user' }, removable: false };
          const provenance: RegistryProvenanceV1 = { sourceId: source.id, format: source.format, sourceUrl: source.url,
            itemId: ref.name, ref, importedAt: item.createdAt };
          return [{ key: item.skillId, provenance, source, ...(item.upstream ? { upstream: item.upstream } : {}) }];
        }
        if (item.provenance.kind !== 'link' || item.provenance.ref.kind !== 'gitTree') return [];
        const ref = item.provenance.ref;
        const linkedRepo = readGitHubRepositoryV1(item.provenance.url);
        const branch = linkedRepo?.url === ref.repo ? linkedRepo.ref : undefined;
        const identityUrl = branch ? `${ref.repo}/tree/${encodeURIComponent(branch)}` : ref.repo;
        // Link imports have an admitted repository in their lock, but no Account
        // registry row. This per-check projection is neither stored nor listed.
        const source: RegistrySourceDescriptorV1 = { id: `link:${deriveRegistrySourceIdV1(identityUrl)}`, title: identityUrl,
          format: 'git', kinds: ['skill'], url: ref.repo, enabled: true, addedAt: item.createdAt,
          ...(branch === undefined ? {} : { ref: branch }),
          origin: { kind: 'user' }, removable: false };
        const provenance: RegistryProvenanceV1 = { sourceId: source.id, format: source.format, sourceUrl: source.url,
          itemId: ref.path, ref, importedAt: item.createdAt };
        return [{ key: item.skillId, provenance, source, ...(item.upstream ? { upstream: item.upstream } : {}) }];
      });
    },
    record,
    applyAutomaticUpdates: record,
  };
}
