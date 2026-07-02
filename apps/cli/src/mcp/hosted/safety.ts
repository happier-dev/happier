import { assertHostedMcpServerRegistration } from './validation';

const MCP_SENSITIVE_REGISTRATION_KEYS = new Set([
    'auth',
    'authorization',
    'credential',
    'credentials',
    'proxyauthorization',
    'apikey',
    'key',
    'token',
    'accesstoken',
    'refreshtoken',
    'githubtoken',
    'clientsecret',
    'pat',
    'password',
    'privatekey',
    'secret',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMcpRegistrationKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isSensitiveMcpRegistrationKey(key: string): boolean {
    const normalized = normalizeMcpRegistrationKey(key);
    return MCP_SENSITIVE_REGISTRATION_KEYS.has(normalized)
        || normalized.endsWith('token')
        || normalized.endsWith('apikey')
        || normalized.endsWith('secret');
}

function normalizeMcpArgFlag(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('-')) {
        return null;
    }
    const flagText = trimmed.slice(0, trimmed.indexOf('=') >= 0 ? trimmed.indexOf('=') : undefined).replace(/^-+/, '');
    const normalized = normalizeMcpRegistrationKey(flagText);
    return normalized.length > 0 ? normalized : null;
}

function isSensitiveMcpArgFlag(value: string): boolean {
    const normalized = normalizeMcpArgFlag(value);
    return normalized !== null && isSensitiveMcpRegistrationKey(normalized);
}

function assertMcpRuntimeRegistrationStringSecretFree(value: string, path: readonly string[]): void {
    if (/\bbearer\s+\S+/i.test(value) || isSensitiveMcpArgFlag(value)) {
        throw new Error(`MCP runtime registration contains raw secret material at '${path.join('.') || '<root>'}'`);
    }
}

export function assertMcpRuntimeRegistrationSecretFree(value: unknown, path: readonly string[] = []): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertMcpRuntimeRegistrationSecretFree(entry, [...path, String(index)]));
        return;
    }
    if (!isRecord(value)) {
        if (typeof value === 'string') {
            assertMcpRuntimeRegistrationStringSecretFree(value, path);
        }
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'function') {
            continue;
        }
        const childPath = [...path, key];
        if (isSensitiveMcpRegistrationKey(key)) {
            throw new Error(`MCP runtime registration contains raw secret material at '${childPath.join('.')}'`);
        }
        assertMcpRuntimeRegistrationSecretFree(child, childPath);
    }
}

export function assertMcpRuntimeServerRegistrationSafe(
    value: unknown,
    options?: Readonly<{ pluginId?: string }>,
): void {
    assertMcpRuntimeRegistrationSecretFree(value);
    assertHostedMcpServerRegistration(value, options);
}
