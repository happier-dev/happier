import type { LocalServiceListenerFact } from '../scanner';

type ProcNetInput = Readonly<{
    tcp4: string;
    tcp6: string;
    inodeToPid: ReadonlyMap<string, number>;
}>;

function parseHexPort(value: string): number | null {
    const port = Number.parseInt(value, 16);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function parseIpv4Hex(value: string): string | null {
    if (!/^[0-9a-f]{8}$/iu.test(value)) return null;
    const bytes = value.match(/../gu);
    if (!bytes || bytes.length !== 4) return null;
    return bytes.reverse().map((byte) => Number.parseInt(byte, 16)).join('.');
}

function parseIpv6Hex(value: string): string | null {
    if (!/^[0-9a-f]{32}$/iu.test(value)) return null;
    const bytes: string[] = [];
    for (let offset = 0; offset < value.length; offset += 8) {
        const word = value.slice(offset, offset + 8);
        bytes.push(word.slice(6, 8), word.slice(4, 6), word.slice(2, 4), word.slice(0, 2));
    }

    const hextets: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 2) {
        hextets.push(Number.parseInt(`${bytes[offset]}${bytes[offset + 1]}`, 16).toString(16));
    }

    return compressIpv6Hextets(hextets);
}

function compressIpv6Hextets(hextets: readonly string[]): string {
    let bestStart = -1;
    let bestLength = 0;
    for (let index = 0; index < hextets.length;) {
        if (hextets[index] !== '0') {
            index += 1;
            continue;
        }
        const start = index;
        while (index < hextets.length && hextets[index] === '0') index += 1;
        const length = index - start;
        if (length > bestLength) {
            bestStart = start;
            bestLength = length;
        }
    }

    if (bestLength < 2) return hextets.join(':');

    const before = hextets.slice(0, bestStart).join(':');
    const after = hextets.slice(bestStart + bestLength).join(':');
    if (!before && !after) return '::';
    if (!before) return `::${after}`;
    if (!after) return `${before}::`;
    return `${before}::${after}`;
}

function parseProcNetTcp(content: string, family: 'ipv4' | 'ipv6', inodeToPid: ReadonlyMap<string, number>): LocalServiceListenerFact[] {
    const listeners: LocalServiceListenerFact[] = [];
    const lines = content.split(/\r?\n/u).slice(1);

    for (const rawLine of lines) {
        const columns = rawLine.trim().split(/\s+/u);
        if (columns.length < 10) continue;
        const localAddress = columns[1];
        const state = columns[3];
        const inode = columns[9];
        if (!localAddress || state !== '0A' || !inode) continue;

        const [addressHex, portHex] = localAddress.split(':');
        if (!addressHex || !portHex) continue;

        const port = parseHexPort(portHex);
        const address = family === 'ipv4' ? parseIpv4Hex(addressHex) : parseIpv6Hex(addressHex);
        if (port == null || !address) continue;

        const pid = inodeToPid.get(inode);
        listeners.push({
            address,
            port,
            protocol: 'tcp',
            ...(pid ? { pid } : {}),
        });
    }

    return listeners;
}

export function parseLinuxProcNetTcpListeners(input: ProcNetInput): LocalServiceListenerFact[] {
    return [
        ...parseProcNetTcp(input.tcp4, 'ipv4', input.inodeToPid),
        ...parseProcNetTcp(input.tcp6, 'ipv6', input.inodeToPid),
    ];
}
