import { approveTerminalPairing } from '@/auth/terminal/approveTerminalPairing';
import { buildEstablishedHomeTransportDescriptor, resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { decodeBase64 } from '@/encryption/base64';
import { parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import type { TerminalEnrollmentForTestOptions } from './terminalEnrollmentIntegrationTestkit.d.mts';

/** Keep the real UI pairing transport alive until the CLI commits enrollment. */
export async function completeTerminalConnectForTest(options: TerminalEnrollmentForTestOptions): Promise<void> {
    const link = parseTerminalConnectUrl(options.connectUrl);
    if (!link?.pairing) throw new Error('Production CLI did not publish a current terminal pairing link');
    const descriptor = link.homeConnectionDescriptor ?? buildEstablishedHomeTransportDescriptor({
        canonicalServerUrl: options.canonicalServerUrl, homeServerIdentityId: options.homeServerIdentityId,
    });
    if (!descriptor) throw new Error('Established fixture Home transport unavailable');
    const resolution = await resolveHomeEnrollmentTransport(descriptor);
    if (!resolution.ok) throw new Error(`Fixture Home pairing unavailable: ${resolution.reason}`);
    try {
        const result = await approveTerminalPairing({
            target: resolution.transport, targetCredentials: options.credentials,
            requesterPublicKey: decodeBase64(link.publicKeyB64Url, 'base64url'),
            pairingContext: { secret: decodeBase64(link.pairing.secretB64Url, 'base64url'),
                createdAtMs: link.pairing.createdAtMs, expiresAtMs: link.pairing.expiresAtMs },
            supportsTokenOnly: link.supportsTokenOnly === true,
        });
        if (result !== 'approved') throw new Error(`Production terminal approval did not complete: ${result}`);
        await options.waitForSuccess();
    } finally { await resolution.transport.close(); }
}
