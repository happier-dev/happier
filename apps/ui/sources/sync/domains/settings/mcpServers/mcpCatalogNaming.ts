import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';

import type { McpServersSettingsV1 } from '@happier-dev/protocol';

const RESERVED_SERVER_NAMES = new Set(['happier', '__proto__', 'prototype', 'constructor']);

export function normalizeMcpServerNameCandidate(raw: string): string {
    const base = String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '');

    return base || 'server';
}

export function toEnvToken(raw: string): string {
    const base = String(raw ?? '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '');

    return base || 'VALUE';
}

export function createUniqueMcpServerName(params: Readonly<{ base: string; settings: McpServersSettingsV1 }>): string {
    const existingNames = new Set(params.settings.servers.map((s) => s.name));
    const base = normalizeMcpServerNameCandidate(params.base);

    const isTaken = (name: string) => RESERVED_SERVER_NAMES.has(name) || existingNames.has(name);
    if (!isTaken(base)) return base;

    for (let i = 2; i < 1000; i += 1) {
        const candidate = `${base}_${i}`;
        if (!isTaken(candidate)) return candidate;
    }

    return `${base}_${Date.now()}`;
}

export function createUniqueSavedSecretName(params: Readonly<{
    base: string;
    secrets: ReadonlyArray<SavedSecret>;
}>): string {
    const existingNames = new Set(params.secrets.map((secret) => secret.name));
    const base = String(params.base ?? '').trim() || 'Secret';
    if (!existingNames.has(base)) return base;

    for (let i = 2; i < 1000; i += 1) {
        const candidate = `${base} ${i}`;
        if (!existingNames.has(candidate)) return candidate;
    }

    return `${base} ${Date.now()}`;
}
