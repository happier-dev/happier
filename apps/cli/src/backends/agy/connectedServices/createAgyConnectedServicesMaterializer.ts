import { cp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { materializeAgyConnectedServiceAuth, requireAgySessionCredential } from './materializeAgyConnectedServiceAuth';

/** Retains vendor state across auth rebuilds and resume only for the same verified Google identity. */
export function createAgyConnectedServicesMaterializer(): ConnectedServicesProviderMaterializer {
  return async (params) => {
    const selected = params.recordsByServiceId.get('antigravity');
    if (!selected) return null;
    const record = requireAgySessionCredential(selected);
    /** Rebuilds staged auth while retaining only verified same-account vendor session state. */
    const write = async () => {
      if (params.previousMaterializedRoot || params.vendorResumeId) {
        const sourceRoot = params.previousMaterializedRoot ?? params.rootDir;
        let owner: unknown;
        try { owner = JSON.parse(await readFile(join(sourceRoot, 'gemini/antigravity-acp/happier-profile.json'), 'utf8')); }
        catch (error) {
          if (params.vendorResumeId) throw new Error('Antigravity resume requires the existing connected profile state');
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const sameAccount = owner && typeof owner === 'object' && 'providerAccountId' in owner
          && owner.providerAccountId === record.oauth.providerAccountId;
        if (params.vendorResumeId && !sameAccount) throw new Error('Antigravity cross-account resume is not supported');
        if (sameAccount && resolve(sourceRoot) !== resolve(params.rootDir)) {
          for (const name of ['conversations', 'brain']) {
            await cp(join(sourceRoot, 'gemini/antigravity-acp', name), join(params.rootDir, 'gemini/antigravity-acp', name), { recursive: true, errorOnExist: false }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
          }
        }
      }
      return materializeAgyConnectedServiceAuth({ rootDir: params.rootDir, record });
    };
    const result = await (params.writeArtifacts ? params.writeArtifacts(write) : write());
    return { env: result.env, cleanupOnFailure: params.cleanupRoot, cleanupOnExit: null };
  };
}
