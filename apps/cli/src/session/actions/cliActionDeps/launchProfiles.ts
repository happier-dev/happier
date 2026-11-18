import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createCliProjectAdmission } from './projectAdmission';
import type { CliActionDepsParams } from './types';
import type { createCliProfileStore, createCliProfileStoreForOperation } from '@/settings/profiles/profileStore';
import type { refreshActiveProfileCatalog } from '@/settings/profiles/hydrateProfileCatalog';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { createLaunchProfilePublisherV1 } from '@happier-dev/protocol/launchProfiles/publishLaunchProfile';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
export function createCliLaunchProfilesActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'savedSecretOperationContext' | 'serverHttpBaseUrl'>,
  { artifactCallerContext, projectAccountAdmission, roleArtifactStore }: Readonly<{
    artifactCallerContext: (context: ActionExecutorContext) => ActionExecutorContext;
    projectAccountAdmission: ReturnType<typeof createCliProjectAdmission>['projectAccountAdmission'];
    roleArtifactStore: ReturnType<typeof createCredentialedAccountArtifactStore> | undefined;
  }>,
): Pick<ActionExecutorDeps, 'launchProfilePublish'> {

  const launchProfilePublicationServerUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  return {
    launchProfilePublish: async (input, context) => {
      const credentials = params.credentials;
      if (!roleArtifactStore || !credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
      const denied = await projectAccountAdmission(undefined, context?.context);
      if (denied) throw createActionExecuteFailureError(denied);
      return await runWithServerHttpBaseUrl(launchProfilePublicationServerUrl, async () => {
        context?.signal?.throwIfAborted();
        if (!params.savedSecretOperationContext && !getActiveAccountSettingsSnapshot()) {
          const { bootstrapAccountSettingsContext } = await import("@/settings/accountSettings/bootstrapAccountSettingsContext");
          await bootstrapAccountSettingsContext({ credentials, mode: 'blocking' });
        }
        const [{ createCliProfileStoreForOperation, createCliProfileStore }, { refreshActiveProfileCatalog }] = await Promise.all([import("@/settings/profiles/profileStore"), import("@/settings/profiles/hydrateProfileCatalog")]);
        const profileStore = params.savedSecretOperationContext
          ? createCliProfileStoreForOperation({ operationContext: params.savedSecretOperationContext, signal: context?.signal })
          : createCliProfileStore({ credentials, signal: context?.signal });
        const refreshCatalog = () => refreshActiveProfileCatalog({ credentials, signal: context?.signal,
          ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}) });
        await refreshCatalog();
        profileStore.assertCurrent();
        let capturedRow: Readonly<{ record: ProfileRecordV1; revision: number }> | null = null;
        return await createLaunchProfilePublisherV1({
          profileStore: {
            read: async profileId => {
              const catalog = await profileStore.readProfileCatalog();
              profileStore.assertCurrent();
              if (catalog.status !== 'ready' || catalog.source !== 'destination') {
                throw Object.assign(new Error('profile_catalog_unavailable'), { code: 'profile_catalog_unavailable' });
              }
              capturedRow = catalog.records.find(row => row.record.id === profileId) ?? null;
              return capturedRow;
            },
            updateDefinition: async ({ profileId, expectedRevision, artifactId }) => {
              profileStore.assertCurrent();
              if (!capturedRow || capturedRow.record.id !== profileId || capturedRow.revision !== expectedRevision) {
                throw Object.assign(new Error('profile_revision_conflict'), { code: 'profile_revision_conflict' });
              }
              const result = await profileStore.writeRecord({
                record: { ...capturedRow.record, definition: { kind: 'artifact', artifactId } },
                expectedRevision, operation: 'update',
              });
              if (result.status !== 'updated') {
                throw Object.assign(new Error(`profile_row_${result.status}`), { code: `profile_row_${result.status}` });
              }
              await refreshCatalog().catch(() => undefined);
            },
          },
          artifactStore: {
            read: (id, signal) => {
              profileStore.assertCurrent();
              return roleArtifactStore.read(id, signal ? { signal } : undefined);
            },
            create: input => {
              profileStore.assertCurrent();
              return roleArtifactStore.create(input);
            },
          },
        }).publish(input, { ...context,
          context: artifactCallerContext(context?.context ?? { surface: 'cli', authority: 'present_user' }) });
      });
    },
  };
}
