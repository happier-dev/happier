import { createHash } from 'node:crypto';

import type { GuestCliIdentityV1 } from '@happier-dev/protocol/features';

const ARCHIVE_PATH = '/fixtures/cli-linux-x64.tar.gz';
const STAGING_DIRECTORY = '/home/guest/.happier/bootstrap-upload.fixture';

export function createNativeSshHomePayload(homeUrl: string, bytes = new TextEncoder().encode('guest CLI fixture archive')) {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const guestCli = {
        source: 'home-payload', line: '0.3', channel: 'stable',
        payloads: [{ target: { os: 'linux', arch: 'x64' }, sha256, url: ARCHIVE_PATH }],
    } satisfies GuestCliIdentityV1;
    const origin = new URL(homeUrl).origin;
    return {
        guestCli,
        versionId: `local-${sha256}`,
        async fetch(url: RequestInfo | URL) {
            const target = new URL(String(url));
            if (target.origin === origin && target.pathname === '/v1/features') return Response.json({ capabilities: { guestCli } });
            if (target.origin === origin && target.pathname === ARCHIVE_PATH) return new Response(new Uint8Array(bytes));
            throw new Error(`Unexpected Home payload request: ${target.origin}${target.pathname}`);
        },
    };
}

export function isNativeSshArchivePromotion(command: string): boolean {
    return command.includes('actual_sha="$(sha256_file "$archive_path")"');
}

/** Model the remote filesystem commands for tests concerned with pairing or SSH trust. */
export function readNativeSshPayloadProcessResult(command: string, promotionStatus = 0) {
    if (isNativeSshArchivePromotion(command)) return { status: promotionStatus, stdout: '', stderr: '' };
    if (command.includes('for version_path in')) return { status: 0, stdout: 'current=\nprevious=\n', stderr: '' };
    if (command.includes('mktemp -d') && command.includes('bootstrap-upload.XXXXXXXX')) {
        return { status: 0, stdout: `${STAGING_DIRECTORY}\n`, stderr: '' };
    }
    if (command.includes(STAGING_DIRECTORY)) return { status: 0, stdout: '', stderr: '' };
    return undefined;
}
