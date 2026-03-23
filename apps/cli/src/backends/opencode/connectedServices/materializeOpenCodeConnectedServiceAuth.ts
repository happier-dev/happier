import { join } from 'node:path';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import {
  buildConnectedServiceOauthAuthEntry,
  requireConnectedServiceTokenCredentialRecord,
  requireConnectedServiceOauthCredentialRecordWithExpiry,
} from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';

export async function materializeOpenCodeConnectedServiceAuth(params: Readonly<{
  rootDir: string;
  openaiCodex: ConnectedServiceCredentialRecordV1 | null;
  openai: ConnectedServiceCredentialRecordV1 | null;
  anthropic: ConnectedServiceCredentialRecordV1 | null;
}>): Promise<Readonly<{ env: Record<string, string> }>> {
  const homeDir = join(params.rootDir, 'home');
  const xdgDataHome = join(params.rootDir, 'xdg', 'data');
  const xdgCacheHome = join(params.rootDir, 'xdg', 'cache');
  const xdgConfigHome = join(params.rootDir, 'xdg', 'config');
  const xdgStateHome = join(params.rootDir, 'xdg', 'state');

  const auth: Record<string, unknown> = {};

  if (params.openaiCodex) {
    const record = requireConnectedServiceOauthCredentialRecordWithExpiry(params.openaiCodex);
    auth.openai = buildConnectedServiceOauthAuthEntry(record);
  } else if (params.openai) {
    const record = requireConnectedServiceTokenCredentialRecord(params.openai);
    auth.openai = {
      type: 'api',
      key: record.token.token,
    };
  }

  if (params.anthropic) {
    if (params.anthropic.kind === 'oauth') {
      throw new Error('Anthropic OAuth credentials are not supported. Reconnect using an Anthropic API key.');
    } else {
      auth.anthropic = {
        type: 'api',
        key: params.anthropic.token.token,
      };
    }
  }

  await writeJsonAtomic(join(xdgDataHome, 'opencode', 'auth.json'), auth);

  return {
    env: {
      HOME: homeDir,
      ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}),
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_STATE_HOME: xdgStateHome,
      // OpenCode uses this as an override for home discovery in multiple subsystems.
      OPENCODE_TEST_HOME: homeDir,
    },
  };
}
