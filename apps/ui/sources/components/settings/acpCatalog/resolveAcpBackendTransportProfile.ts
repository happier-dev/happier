import type {
    AcpBackendAuthConfigV1,
    AcpCatalogTransportProfileV1,
} from '@happier-dev/protocol';

type TransportProfileInput = Readonly<{
    command: string;
    auth?: AcpBackendAuthConfigV1;
}>;

function isKiroCommand(command: string): boolean {
    const trimmed = command.trim().toLowerCase();
    return trimmed === 'kiro-cli' || trimmed === 'kiro-cli.cmd' || trimmed === 'kiro-cli.exe';
}

export function resolveAcpBackendTransportProfile(input: TransportProfileInput): AcpCatalogTransportProfileV1 {
    if (input.auth?.parser === 'kiroWhoamiJson') {
        return 'kiro';
    }

    if (isKiroCommand(input.command)) {
        return 'kiro';
    }

    return 'generic';
}
