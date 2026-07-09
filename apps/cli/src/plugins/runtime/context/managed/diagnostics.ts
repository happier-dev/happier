import type {
    ExecClientDiagnosticSanitizerV1,
    ExecLaunchInputV1,
    ManagedServerCredentialV1,
} from '@happier-dev/plugin-sdk';

import {
    classifyConnectedServiceSensitiveDiagnosticKey,
    CONNECTED_SERVICE_SECRET_REDACTION_MARKER,
    resolveConnectedServiceSensitiveDiagnosticMarker,
} from '@/daemon/connectedServices/runtimeAuth/sensitiveConnectedServiceDiagnosticFields';
import { sanitizeExecDiagnosticText } from '../../exec/errors';

type ManagedServerDiagnosticHealthCheck = Readonly<
    | {
        kind: 'http';
        url: string;
        headers: Readonly<Record<string, string>>;
    }
    | {
        kind: 'command';
        launch: ExecLaunchInputV1;
    }
>;

export type ManagedServerDiagnosticSanitizer = Readonly<{
    options: ExecClientDiagnosticSanitizerV1;
}>;

const SECRET_ASSIGNMENT_PATTERN = /\b([A-Za-z][A-Za-z0-9_.-]*)(?:"?)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s;,]+)/gu;

function addRedactedValue(values: Set<string>, value: string | undefined): void {
    const trimmed = value?.trim();
    if (trimmed) {
        values.add(trimmed);
    }
}

function addSensitiveRecordValues(values: Set<string>, record: Readonly<Record<string, string>> | undefined): void {
    if (!record) {
        return;
    }
    for (const [key, value] of Object.entries(record)) {
        if (classifyConnectedServiceSensitiveDiagnosticKey(key) === 'secret') {
            addRedactedValue(values, value);
        }
    }
}

function readArgKey(arg: string): string | null {
    if (!arg.startsWith('-')) {
        return null;
    }
    const withoutPrefix = arg.replace(/^-+/u, '');
    const separatorIndex = withoutPrefix.search(/[=:]/u);
    return separatorIndex >= 0 ? withoutPrefix.slice(0, separatorIndex) : withoutPrefix;
}

function readInlineArgValue(arg: string): string | null {
    const separatorIndex = arg.search(/[=:]/u);
    if (separatorIndex < 0) {
        return null;
    }
    return arg.slice(separatorIndex + 1);
}

function addLaunchArgRedactedValues(values: Set<string>, args: readonly string[] | undefined): void {
    if (!args) {
        return;
    }
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const key = readArgKey(arg);
        if (classifyConnectedServiceSensitiveDiagnosticKey(key ?? undefined) !== 'secret') {
            continue;
        }
        const inlineValue = readInlineArgValue(arg);
        if (inlineValue !== null) {
            addRedactedValue(values, inlineValue);
            continue;
        }
        const next = args[index + 1];
        if (next !== undefined && !next.startsWith('-')) {
            addRedactedValue(values, next);
        }
    }
}

function addLaunchRedactedValues(values: Set<string>, launch: ExecLaunchInputV1 | undefined | null): void {
    if (!launch || launch.kind === 'ipc') {
        return;
    }
    addSensitiveRecordValues(values, launch.env);
    addLaunchArgRedactedValues(values, launch.args);
}

function addUrlRedactedValues(values: Set<string>, url: string | undefined): void {
    if (!url) {
        return;
    }
    try {
        const parsed = new URL(url);
        addRedactedValue(values, parsed.username);
        addRedactedValue(values, parsed.password);
        for (const [key, value] of parsed.searchParams.entries()) {
            if (classifyConnectedServiceSensitiveDiagnosticKey(key) === 'secret') {
                addRedactedValue(values, value);
            }
        }
    } catch {
        // Non-URL strings are still handled by the generic diagnostic sanitizer.
    }
}

export function createManagedServerDiagnosticSanitizer(params: Readonly<{
    credential: ManagedServerCredentialV1 | null;
    healthCheck: ManagedServerDiagnosticHealthCheck;
    launch?: ExecLaunchInputV1 | null;
}>): ManagedServerDiagnosticSanitizer {
    const redactedValues = new Set<string>();
    addRedactedValue(redactedValues, params.credential?.value);
    addRedactedValue(redactedValues, params.credential?.httpHeader?.value);
    addLaunchRedactedValues(redactedValues, params.launch);
    if (params.healthCheck.kind === 'http') {
        addUrlRedactedValues(redactedValues, params.healthCheck.url);
        addSensitiveRecordValues(redactedValues, params.healthCheck.headers);
    } else {
        addLaunchRedactedValues(redactedValues, params.healthCheck.launch);
    }
    return Object.freeze({
        options: Object.freeze({
            redactedValues: Object.freeze([...redactedValues]),
        }),
    });
}

export function sanitizeManagedServerDiagnosticText(
    value: string,
    sanitizer: ManagedServerDiagnosticSanitizer,
    maxBytes = -1,
): string {
    return sanitizeExecDiagnosticText(value, maxBytes, sanitizer.options)
        .replace(SECRET_ASSIGNMENT_PATTERN, (match, rawKey: string) => (
            classifyConnectedServiceSensitiveDiagnosticKey(rawKey) === 'secret'
                ? `${rawKey}=${CONNECTED_SERVICE_SECRET_REDACTION_MARKER}`
                : match
        ));
}

export function sanitizeManagedServerDiagnosticUrl(
    url: string,
    sanitizer: ManagedServerDiagnosticSanitizer,
): string {
    try {
        const parsed = new URL(url);
        if (parsed.username) {
            parsed.username = resolveConnectedServiceSensitiveDiagnosticMarker('secret');
        }
        if (parsed.password) {
            parsed.password = resolveConnectedServiceSensitiveDiagnosticMarker('secret');
        }
        const sanitizedSearchParams = new URLSearchParams();
        for (const [key, value] of parsed.searchParams.entries()) {
            if (classifyConnectedServiceSensitiveDiagnosticKey(key) === 'secret') {
                sanitizedSearchParams.append(key, resolveConnectedServiceSensitiveDiagnosticMarker('secret'));
                continue;
            }
            sanitizedSearchParams.append(key, sanitizeManagedServerDiagnosticText(value, sanitizer));
        }
        parsed.search = sanitizedSearchParams.toString();
        return parsed.toString();
    } catch {
        return sanitizeManagedServerDiagnosticText(url, sanitizer);
    }
}
