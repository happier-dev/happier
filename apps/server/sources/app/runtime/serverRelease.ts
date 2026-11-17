import packageJson from '../../../package.json' with { type: 'json' };
import type { GuestCliIdentityV1 } from '@happier-dev/protocol/features/payload/capabilities/guestCliIdentityV1';
import { readServerGuestCliPayloads } from './serverGuestCliPayload';

declare const __HAPPIER_GUEST_CLI_SOURCE__: GuestCliIdentityV1['source'];
declare const __HAPPIER_GUEST_CLI_CHANNEL__: GuestCliIdentityV1['channel'];

/** The source program's line is explicit: unreleased package stamps can still say 0.2. */
const GUEST_CLI_LINE = '0.3';

/** Build producers select the guest artifact family; direct source runs serve Home payloads. */
export function readServerGuestCliIdentity(env: NodeJS.ProcessEnv = process.env): GuestCliIdentityV1 {
    const source = typeof __HAPPIER_GUEST_CLI_SOURCE__ === 'undefined' ? 'home-payload' : __HAPPIER_GUEST_CLI_SOURCE__;
    const payloads = source === 'home-payload' ? readServerGuestCliPayloads(env) : [];
    return {
        source,
        line: GUEST_CLI_LINE,
        channel: typeof __HAPPIER_GUEST_CLI_CHANNEL__ === 'undefined' ? 'publicdev' : __HAPPIER_GUEST_CLI_CHANNEL__,
        ...(payloads.length ? { payloads } : {}),
    };
}

/**
 * The release version of the running server binary (plan `2026-09-26-home-owner-console` §3.7).
 *
 * Release automation stamps this package's version at every release (`bump-version`, preview
 * versions), and the binary builds and the deployment image carry that `package.json`, so the
 * server can state which release it is instead of a client inferring it from a host runtime that
 * may not be the same binary. Diagnostic only; never a gate.
 */
export function readServerReleaseVersion(): string | null {
    const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : '';
    return version.length > 0 ? version : null;
}
