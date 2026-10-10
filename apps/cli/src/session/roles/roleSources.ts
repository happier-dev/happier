import { createRoleSourceReaderV1, type RoleSourceReaderV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import type { PluginRoleContributionV1 } from '@happier-dev/protocol';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readPluginRoleSources } from '@/plugins/projection/registry/roles';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';

export type RoleSourceReaderParams = Readonly<{
  artifactStore?: Pick<ReturnType<typeof createAccountArtifactStore>, 'read' | 'list'>;
  readPluginRoles?: () => readonly PluginRoleContributionV1[];
  accountId?: string;
  readRawAccountSettings?: () => Promise<Readonly<Record<string, unknown>>>;
}>;
export type RoleSourceReader = RoleSourceReaderV1;

/** One source reader for Action, prompt and permission role resolution. */
export function createRoleSourceReader(params: RoleSourceReaderParams): RoleSourceReader {
  const readPluginRoles = params.readPluginRoles ?? (() => readPluginRoleSources(readCurrentContributionRegistry()));
  return createRoleSourceReaderV1({ ...params, readPluginRoles });
}
