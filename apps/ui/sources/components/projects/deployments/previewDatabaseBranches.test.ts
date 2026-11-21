import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { PLUGIN_MANIFEST as neon } from '../../../../../../packages/plugins/deployment-neon/src/manifest';
import { PLUGIN_MANIFEST as supabase } from '../../../../../../packages/plugins/deployment-supabase/src/manifest';
import { branchListInput, inputSchema } from '../../../../../../packages/plugins/deployment-neon/src/data/schemas';
import { actionSchema } from '../../../../../../packages/plugins/deployment-supabase/src/data/schemas';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/jsonSchemaValidation';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { buildPreviewBranchReadInput, previewBranchTargets, readPreviewBranchParents } from './previewDatabaseBranches';

function linked(pluginId: string, project: string, environment: string) {
  return { targetLink: createDeploymentTargetLinkHeaderV1({ role: 'data', targetKind: 'managed', machines: [], members: [], source: { kind: 'plugin',
    contribution: { pluginId, localId: 'database' } } }), content: {
    providerIdentity: { providerAccountId: 'organization', providerResourceId: project, providerEnvironment: environment },
    providerEnvironment: { kind: 'native' as const, selection: { branchId: environment } },
    credentialPrincipal: { kind: 'account' as const, accountId: 'owner',
      purpose: { consumer: { pluginId, localId: 'projects-link' }, purpose: 'deploy-manage' },
      target: { kind: 'account' as const, account: { service: { pluginId, localId: 'database' }, accountId: 'token' } } },
  } };
}

it('discovers branch reads from real Neon and Supabase contributions and preserves the recorded custody in each admitted input', () => {
  for (const [manifest, schema] of [[neon, inputSchema(branchListInput, true)], [supabase, actionSchema('branches-list')]] as const) {
    const row = linked(manifest.id, 'project', 'main');
    const detail = { ...createDeploymentEnvironmentDetailV1({ targetLinks: [row] }), runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
    const choices = previewBranchTargets([{ manifest: PluginPortableReleaseManifestV1Schema.parse(manifest) }], detail);
    expect(choices).toHaveLength(1);
    const choice = choices[0]!;
    expect(choice.actionId).toContain(manifest.id);
    const input = buildPreviewBranchReadInput(detail, choice);
    expect(input).toMatchObject({ targetLinkId: row.targetLink.id, expectedTargetLinkRevision: row.targetLink.revision,
      credentialPrincipal: row.content.credentialPrincipal, credentialRef: row.content.credentialPrincipal.target.account,
      providerIdentity: row.content.providerIdentity, providerEnvironment: row.content.providerEnvironment });
    expect(compilePluginJsonSchema(schema)(input)).toBe(true);
  }
});

it('offers only the parent selected by the linked provider identity, preserving each provider’s project/branch coordinates', () => {
  const neonLink = linked(neon.id, 'project', 'main');
  expect(readPreviewBranchParents({ branches: [
    { providerProjectId: 'project', branchId: 'main', name: 'Production' },
    { providerProjectId: 'project', branchId: 'other', name: 'Another branch' },
  ] }, neonLink.content.providerIdentity)).toEqual([{ title: 'Production', parentBranchRef: { providerProjectId: 'project', branchId: 'main', displayName: 'Production' } }]);
  const supabaseLink = linked(supabase.id, 'project', 'selected-ref');
  expect(readPreviewBranchParents({ branches: [
    { parentProjectRef: 'project', projectRef: 'selected-ref', branchId: 'uuid', name: 'Production' },
    { parentProjectRef: 'project', projectRef: 'other-ref', branchId: 'other-uuid', name: 'Other' },
  ] }, supabaseLink.content.providerIdentity)).toEqual([{ title: 'Production', parentBranchRef: { providerProjectId: 'selected-ref', branchId: 'uuid', displayName: 'Production' } }]);
  expect(readPreviewBranchParents({ branches: [] }, neonLink.content.providerIdentity)).toEqual([]);
});
