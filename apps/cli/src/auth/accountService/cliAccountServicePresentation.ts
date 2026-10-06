import { AccountDirectoryCapabilitiesSchema } from '@happier-dev/protocol/features/payload/capabilities/accountDirectoryCapabilities';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/agents';

import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

import { createCliAccountServiceSessionOwner } from './cliAccountServiceSession';

export type CliSelectedAccountServicePresentation = Readonly<{
  displayName: string;
  endpoint: string;
  serverIdentityId: string;
}>;

/** Read-only presentation for a selected service whose current identity and role are verified. */
export async function resolveCliSelectedAccountServicePresentation(input: Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}> = {}): Promise<CliSelectedAccountServicePresentation | null> {
  try {
    const session = createCliAccountServiceSessionOwner({
      happyHomeDir: resolveHappyHomeDirFromEnvironment(process.env),
    });
    const selection = await session.readSelection();
    if (!selection) return null;
    const snapshot = await fetchServerFeaturesSnapshot({
      serverUrl: selection.endpoint,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    if (snapshot.status !== 'ready') return null;
    const identity = normalizeServerIdentityIdCapability(
      snapshot.features.capabilities.serverIdentity.serverIdentityId,
    );
    const canonicalServerUrl = snapshot.features.capabilities.server.canonicalServerUrl?.replace(/\/+$/u, '');
    const directory = AccountDirectoryCapabilitiesSchema.safeParse(
      snapshot.features.capabilities.accountDirectory,
    );
    const displayName = snapshot.features.accountServicePresentation?.displayName.trim();
    if (
      identity !== selection.serverIdentityId
      || canonicalServerUrl !== selection.canonicalServerUrl
      || !directory.success
      || !directory.data.homeDirectory
      || !displayName
    ) {
      return null;
    }
    return { displayName, endpoint: selection.endpoint, serverIdentityId: identity };
  } catch {
    return null;
  }
}
