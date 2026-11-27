import type { Buffer } from 'node:buffer';

export const SCHEMA_SECTIONS: readonly ['inputSchema', 'resultSchema'];
export type SchemaSection = typeof SCHEMA_SECTIONS[number];
export type SchemaValues = Record<string, unknown>;
export type DeclarationSummary = Readonly<{
    v: 1;
    declarationDigest: string;
    canonicalDeclarationDigest: string;
    manifest: Record<string, unknown>;
    inputHintsByActionId: Readonly<Record<string, unknown>>;
}>;
export function renderIndexedBundledDeclaration(projection: Readonly<{
    summary: DeclarationSummary;
    inputSchema: { valuesByActionId: SchemaValues };
    resultSchema: { valuesByActionId: SchemaValues };
}>): string;
export function withIndexedBundledDeclaration<T>(path: string | URL, consume: (
    header: DeclarationSummary,
    readSection: (section: SchemaSection) => SchemaValues,
) => T): T;
export function readIndexedBundledDeclarationManifest(path: string | URL): Record<string, unknown>;
export function decodeIndexedBundledDeclarationManifest(bytes: Buffer): Record<string, unknown>;
export function decodeBundledDeclarationManifest(bytes: Buffer): Record<string, unknown>;
