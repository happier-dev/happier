import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
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
import { logger } from '@/ui/logger';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import { resolvePinnedAgyAcpServerHome } from '../acp/pinnedAgyAcpServer';
import { parseAgyNativeCredential } from '../cloud/nativeCredentials';
import { agyConnectedServiceStateSharingDescriptor } from './agyConnectedServiceStateSharingDescriptor';
import { resolveConnectedAccountOauthConfig } from '@/daemon/connectedServices/descriptors/connectedAccountDescriptors';

export function createAgyConnectedServicesMaterializer(): ConnectedServicesProviderMaterializer {
  return async (params) => {
    const selected = params.recordsByServiceId.get('antigravity');
    if (!selected) return null;
    const record = requireConnectedServiceOauthCredentialRecord(selected);
    if (!record.oauth.refreshToken) throw new Error('antigravity_refresh_token_required');
    const raw = record.oauth.raw;
    const selectedProjectId = raw && typeof raw === 'object' && !Array.isArray(raw)
      && 'project_id' in raw && typeof raw.project_id === 'string' ? raw.project_id.trim() : '';
    const probing = params.materializationPurpose === 'probe';
    const home = probing ? join(params.rootDir, 'gemini-home') : resolveConnectedServiceHomeDir({
      activeServerDir: params.activeServerDir, serviceId: 'antigravity', profileId: record.profileId, agentId: 'agy',
    });
    const env = { GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: '1' };
    const settings = params.accountSettings;
    const policy = resolveConnectedServicesProviderStateSharingPolicyV1(settings?.connectedServicesProviderStateSharingSettingsV1, 'agy');
    const sourceEnv = params.processEnv ?? process.env;
    const oauthConfig = resolveConnectedAccountOauthConfig('antigravity', sourceEnv);
    const nativeHome = resolvePinnedAgyAcpServerHome(sourceEnv);
    const write = async () => {
      const existingManifest = await readConnectedServiceStateSharingManifest(home);
      const tokenPath = join(home, 'antigravity-acp', 'acp_token.json');
      let projectId = selectedProjectId;
      if (!projectId && !probing) {
        let contents: string | null = null;
        try { contents = await readFile(tokenPath, 'utf8'); } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        if (contents !== null) {
          let value: unknown;
          try { value = JSON.parse(contents); } catch {
            logger.warn('[connected-services] Replacing malformed Antigravity credential projection with the selected account credentials');
          }
          const previous = parseAgyNativeCredential(value, 'acp');
          if (previous?.refreshToken === record.oauth.refreshToken) projectId = previous.projectId ?? '';
        }
      }
      await writeJsonAtomic(tokenPath, {
        client_id: oauthConfig.clientId,
        ...(oauthConfig.clientSecret ? { client_secret: oauthConfig.clientSecret } : {}),
        token_uri: oauthConfig.tokenUrl,
        scopes: record.oauth.scope?.split(/\s+/).filter(Boolean) ?? [],
        refresh_token: record.oauth.refreshToken,
        token: record.oauth.accessToken,
        ...(projectId ? { project_id: projectId } : {}),
        ...(record.expiresAt != null ? { expiry: new Date(record.expiresAt).toISOString().replace('.000Z', 'Z') } : {}),
      });
      await writeJsonAtomic(join(home, 'antigravity-acp', 'settings.json'), { auth: { type: 'oauth-personal' } });
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
        providerLabel: 'Antigravity ACP',
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
