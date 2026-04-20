import { join } from 'node:path';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import {
    buildConnectedServiceOauthAuthEntry,
    requireConnectedServiceOauthCredentialRecordWithExpiry,
    requireConnectedServiceTokenCredentialRecord,
} from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';

async function validateOpenAiCodexRefreshTokenOrThrow(record: ConnectedServiceCredentialRecordV1): Promise<void> {
    const oauth = requireConnectedServiceOauthCredentialRecordWithExpiry(record);

    // This is intentionally a "stale token probe" rather than a full auth flow. The tests
    // stub `fetch`, and the concrete endpoint/shape is not part of a published contract yet.
    const response = await fetch('https://api.openai.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: oauth.oauth.refreshToken,
        }),
    });

    if (response.ok) return;

    let bodyText = '';
    try {
        bodyText = await response.text();
    } catch {
        bodyText = '';
    }

    const haystack = bodyText.toLowerCase();
    const looksStale =
        response.status === 401
        && (haystack.includes('refresh token has already been used')
            || haystack.includes('stale refresh')
            || haystack.includes('invalid refresh'));
    if (looksStale) {
        throw new Error('Stale or invalid OpenAI refresh token. Please sign in again.');
    }

    throw new Error(`OpenAI oauth refresh probe failed (status=${response.status}).`);
}

export async function materializeOpenCodeConnectedServiceAuth(params: Readonly<{
    rootDir: string;
    openaiCodex: ConnectedServiceCredentialRecordV1 | null;
    openai: ConnectedServiceCredentialRecordV1 | null;
    anthropic: ConnectedServiceCredentialRecordV1 | null;
}>): Promise<Readonly<{ env: Record<string, string> }>> {
    const xdgDataHome = join(params.rootDir, 'xdg', 'data');
    const xdgCacheHome = join(params.rootDir, 'xdg', 'cache');
    const xdgConfigHome = join(params.rootDir, 'xdg', 'config');
    const xdgStateHome = join(params.rootDir, 'xdg', 'state');

    const auth: Record<string, unknown> = {};

    if (params.openaiCodex) {
        await validateOpenAiCodexRefreshTokenOrThrow(params.openaiCodex);
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
        }
        auth.anthropic = {
            type: 'api',
            key: params.anthropic.token.token,
        };
    }

    await writeJsonAtomic(join(xdgDataHome, 'opencode', 'auth.json'), auth);

    // Deliberately do not set HOME/USERPROFILE/OPENCODE_TEST_HOME; OpenCode should rely on XDG roots.
    return {
        env: {
            XDG_DATA_HOME: xdgDataHome,
            XDG_CACHE_HOME: xdgCacheHome,
            XDG_CONFIG_HOME: xdgConfigHome,
            XDG_STATE_HOME: xdgStateHome,
        },
    };
}
