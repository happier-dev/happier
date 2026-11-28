import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { resolveConnectedServicesProviderStateSharingPolicyV1 } from '@happier-dev/protocol';
import {
  CONNECTED_SERVICE_MATERIALIZATION_REASONS,
  type ConnectedServicesMaterializeResult,
  type ConnectedServicesProviderMaterializer,
} from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { requireConnectedServiceOauthCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';
import { applyConnectedServiceStateSharingDescriptor } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { readConnectedServiceStateSharingManifest, writeConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import { resolveAgyMachineProfileDir } from '../acp/agyAcpLaunch';
import { AGY_NATIVE_TOKEN_FILE_SEGMENTS, serializeAgyNativeCliCredential } from '../cloud/nativeCredentials';
import { agyConnectedServiceStateSharingDescriptor } from './agyConnectedServiceStateSharingDescriptor';

export function createAgyConnectedServicesMaterializer(): ConnectedServicesProviderMaterializer {
  return async (params) => {
    const selected = params.recordsByServiceId.get('antigravity');
    if (!selected) return null;
    const record = requireConnectedServiceOauthCredentialRecord(selected);
    const refreshToken = record.oauth.refreshToken;
    if (!refreshToken) throw new Error('antigravity_refresh_token_required');
    const probing = params.materializationPurpose === 'probe';
    const home = probing ? join(params.rootDir, 'gemini-home') : resolveConnectedServiceHomeDir({
      activeServerDir: params.activeServerDir, serviceId: 'antigravity', profileId: record.profileId, agentId: 'agy',
    });
    // The launch passes this profile as `--gemini-dir` and forces file token storage for that child only.
    const env = { GEMINI_HOME: home };
    const settings = params.accountSettings;
    const policy = resolveConnectedServicesProviderStateSharingPolicyV1(settings?.connectedServicesProviderStateSharingSettingsV1, 'agy');
    const sourceEnv = params.processEnv ?? process.env;
    const nativeHome = resolveAgyMachineProfileDir(sourceEnv);
    const write = async () => {
      const existingManifest = await readConnectedServiceStateSharingManifest(home);
      await writeJsonAtomic(join(home, ...AGY_NATIVE_TOKEN_FILE_SEGMENTS), serializeAgyNativeCliCredential({
        accessToken: record.oauth.accessToken, refreshToken, expiresAt: record.expiresAt ?? null, email: record.oauth.providerEmail,
      }));
      const applied = await applyConnectedServiceStateSharingDescriptor({
        descriptor: agyConnectedServiceStateSharingDescriptor,
        nativeSourceContext: { sourceRoot: nativeHome, sourceEnv: Object.fromEntries(Object.entries(sourceEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) },
        target: { targetMaterializedRoot: home, targetMaterializedEnv: env },
        configMode: probing ? 'isolated' : policy.configMode,
        requestedStateMode: probing ? 'isolated' : policy.stateMode,
        effectiveStateMode: probing ? 'isolated' : policy.stateMode,
        existingManifest,
        sessionImportRoots: probing ? undefined : agyConnectedServiceStateSharingDescriptor.state.entries.map(entry => ({
          sourceRoot: join(home, entry.path), destinationRoot: join(nativeHome, entry.path),
        })),
        cwd: params.sessionDirectory ?? '',
        prepareSharedStateSource: async () => {
          await Promise.all(agyConnectedServiceStateSharingDescriptor.state.entries.map(entry => mkdir(join(nativeHome, entry.path), { recursive: true })));
        },
        providerLabel: 'Antigravity',
      });
      await writeConnectedServiceStateSharingManifest(home, applied.manifest);
      return applied;
    };
    return await withConnectedServiceStateSharingDestinationLock(home, async (): Promise<ConnectedServicesMaterializeResult> => {
      const selection = params.selectionsByServiceId?.get('antigravity');
      if (selection?.kind === 'group' && params.validateGroupMutationCurrentness) {
        const current = await params.validateGroupMutationCurrentness({
          serviceId: 'antigravity', groupId: selection.groupId, profileId: record.profileId,
          generation: selection.generation, credentialRevision: selection.credentialRevision ?? null,
        });
        if (!current.current) {
          return {
            env, targetMaterializedRoot: home,
            diagnostics: [{
              code: 'agy_connected_service_generation_superseded', providerId: 'agy', serviceId: 'antigravity',
              severity: 'blocking', reason: CONNECTED_SERVICE_MATERIALIZATION_REASONS.authoritativeGroupTargetSuperseded,
            }],
            cleanupOnFailure: probing ? params.cleanupRoot : null, cleanupOnExit: null,
          };
        }
      }
      const applied = await (params.writeArtifacts ? params.writeArtifacts(write) : write());
      return { env: { ...env, ...applied.envOverrides }, targetMaterializedRoot: home,
        diagnostics: applied.diagnostics, cleanupOnFailure: probing ? params.cleanupRoot : null, cleanupOnExit: null };
    }, { providerId: 'agy' });
  };
}
