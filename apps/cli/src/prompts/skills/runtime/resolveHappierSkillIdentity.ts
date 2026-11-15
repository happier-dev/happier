import type { AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { resolveSessionSkillByNameV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';

type DeliveredSkillItem = AgentSessionSkillDelivery['items'][number];
// Name reads need only the admitted identity; native-path reads also need the item directory.
type SkillIdentityDelivery = Readonly<{
  items: readonly (Pick<DeliveredSkillItem, 'skillId' | 'name' | 'digest'> & Partial<Pick<DeliveredSkillItem, 'directory'>>)[];
}>;

export function resolveHappierSkillIdentity(
  input: Readonly<{ name?: string; path?: string }>,
  delivery: SkillIdentityDelivery | undefined,
  happyHomeDir?: string,
): string | null {
  if (!delivery) return null;
  if (input.path) {
    for (const item of delivery.items) {
      if ((item.directory !== undefined && isCanonicalAbsolutePathInsideRoot(item.directory, input.path))
        || (happyHomeDir && isCanonicalAbsolutePathInsideRoot(
          `${happyHomeDir}/skills/cache/${item.digest.slice('sha256:'.length)}`, input.path,
        ))) return item.skillId;
    }
    // A reported native path is decisive even if its name matches a delivered item.
    return null;
  }
  return resolveSessionSkillByNameV1(input.name, delivery.items)?.skillId ?? null;
}
