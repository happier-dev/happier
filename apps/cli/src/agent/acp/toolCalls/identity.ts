import { createHash } from 'node:crypto';

import type { AcpToolIdentity } from './types';

type AcpToolIdentityInput = Readonly<{
    sessionId: string;
    turnId: string;
    sidechainId: string | null;
    toolCallId: string;
}>;

type OpaqueIdentityPart = string | null | undefined;

function assertNonBlankOpaqueIdentity(name: string, value: string): void {
    if (value.trim().length === 0) {
        throw new Error(`ACP tool ${name} identity must be non-empty`);
    }
}

function encodeLengthDelimited(parts: readonly OpaqueIdentityPart[]): Buffer {
    const chunks: Buffer[] = [];
    for (const part of parts) {
        if (part === undefined) {
            chunks.push(Buffer.from('u:', 'utf8'));
            continue;
        }
        if (part === null) {
            chunks.push(Buffer.from('n:', 'utf8'));
            continue;
        }
        const bytes = Buffer.from(part, 'utf8');
        chunks.push(Buffer.from(`s${bytes.length}:`, 'utf8'), bytes);
    }
    return Buffer.concat(chunks);
}

function operationalId(domain: 'call' | 'result', encodedIdentity: Buffer): string {
    const digest = createHash('sha256')
        .update(`happier-acp-tool-${domain}-v1\0`, 'utf8')
        .update(encodedIdentity)
        .digest('base64url');
    return `acp-${domain}-v1:${digest}`;
}

export function createAcpToolIdentity(input: AcpToolIdentityInput): AcpToolIdentity {
    assertNonBlankOpaqueIdentity('session', input.sessionId);
    assertNonBlankOpaqueIdentity('turn', input.turnId);
    assertNonBlankOpaqueIdentity('call', input.toolCallId);
    if (input.sidechainId !== null) {
        assertNonBlankOpaqueIdentity('sidechain', input.sidechainId);
    }
    const encodedIdentity = encodeLengthDelimited([
        input.sessionId,
        input.turnId,
        input.sidechainId,
        input.toolCallId,
    ]);
    return Object.freeze({
        // latin1 is a reversible byte-to-code-unit mapping. This exact key stays in memory only.
        correlationKey: encodedIdentity.toString('latin1'),
        callLocalId: operationalId('call', encodedIdentity),
        resultLocalId: operationalId('result', encodedIdentity),
    });
}

export function createAcpTurnIdentity(input: Readonly<{
    sessionId: string;
    turnId: string;
    /** `undefined` denotes every sidechain; `null` denotes only the main turn. */
    sidechainId?: string | null;
}>): string {
    assertNonBlankOpaqueIdentity('session', input.sessionId);
    assertNonBlankOpaqueIdentity('turn', input.turnId);
    if (input.sidechainId !== undefined && input.sidechainId !== null) {
        assertNonBlankOpaqueIdentity('sidechain', input.sidechainId);
    }
    return encodeLengthDelimited([input.sessionId, input.turnId, input.sidechainId]).toString('latin1');
}
