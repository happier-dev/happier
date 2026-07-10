const SECRET_FIELD_VALUE_PATTERN =
    /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|password|token|secret)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}/i;
const AUTHORIZATION_BEARER_VALUE_PATTERN = /\bauthorization\s*:\s*bearer\s+\S+/i;
const X_API_KEY_HEADER_VALUE_PATTERN = /\bx-api-key\s*:\s*\S{12,}/i;
const JWT_VALUE_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/;
const AWS_ACCESS_KEY_VALUE_PATTERN = /\b(?:A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/;
const GITHUB_TOKEN_VALUE_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/;
const OPENAI_SECRET_KEY_VALUE_PATTERN = /\bsk-[A-Za-z0-9]{20,}\b/;

export function containsUnsafeDiagnosticText(value: string | undefined): boolean {
    if (!value) return false;
    return SECRET_FIELD_VALUE_PATTERN.test(value)
        || AUTHORIZATION_BEARER_VALUE_PATTERN.test(value)
        || X_API_KEY_HEADER_VALUE_PATTERN.test(value)
        || JWT_VALUE_PATTERN.test(value)
        || AWS_ACCESS_KEY_VALUE_PATTERN.test(value)
        || GITHUB_TOKEN_VALUE_PATTERN.test(value)
        || OPENAI_SECRET_KEY_VALUE_PATTERN.test(value);
}

export function isUnsafeDiagnosticHeaderName(headerName: string): boolean {
    const normalized = headerName.trim().toLowerCase();
    return normalized === 'authorization'
        || normalized === 'proxy-authorization'
        || normalized === 'cookie'
        || normalized === 'set-cookie'
        || normalized.includes('authorization')
        || normalized.includes('token')
        || normalized.includes('secret')
        || normalized.includes('api-key');
}
