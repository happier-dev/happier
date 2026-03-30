import type { ActionInputFieldHint, ActionSpec } from '@happier-dev/protocol';

import { t } from '@/text';

type ValidationIssue = Readonly<{
    code?: string;
    message?: string;
    minimum?: number;
    path?: readonly unknown[];
    received?: unknown;
}>;

function normalizeIssuePath(path: readonly unknown[] | undefined): string {
    if (!Array.isArray(path) || path.length === 0) return '';
    return path
        .map((part) => (typeof part === 'string' || typeof part === 'number' ? String(part).trim() : ''))
        .filter((part) => part.length > 0)
        .join('.');
}

function resolveFieldLabel(fields: readonly ActionInputFieldHint[], issuePath: string): string | null {
    if (!issuePath) return null;
    const field = fields.find((entry) => entry.path === issuePath) ?? null;
    if (!field) return issuePath;
    const title = typeof field.title === 'string' ? field.title.trim() : '';
    return title.length > 0 ? title : issuePath;
}

function isRequiredIssue(issue: ValidationIssue): boolean {
    if (issue.code === 'too_small' && issue.minimum === 1) return true;
    if (issue.code === 'invalid_type') {
        if (issue.received === 'undefined' || issue.received === undefined || issue.received === null) {
            return true;
        }
        const message = typeof issue.message === 'string' ? issue.message.toLowerCase() : '';
        if (message.includes('received undefined')) {
            return true;
        }
    }
    return false;
}

export function resolveActionInputValidationError(args: Readonly<{
    sessionId: string;
    input: Record<string, unknown>;
    spec: ActionSpec;
    fields: readonly ActionInputFieldHint[];
}>): string | null {
    const parsed = (args.spec.inputSchema as { safeParse: (value: unknown) => unknown }).safeParse({
        sessionId: args.sessionId,
        ...(args.input ?? {}),
    }) as
        | { success: true }
        | { success: false; error?: { issues?: readonly ValidationIssue[] } };
    if (parsed.success) return null;

    const first = Array.isArray(parsed.error?.issues) ? parsed.error.issues[0] : null;
    if (!first) return t('common.requestFailed');

    const fieldLabel = resolveFieldLabel(args.fields, normalizeIssuePath(first.path));
    if (fieldLabel && isRequiredIssue(first)) {
        return t('session.actionsDraft.validation.requiredField', { field: fieldLabel });
    }

    const message = typeof first.message === 'string' ? first.message.trim() : '';
    if (fieldLabel && message.length > 0) {
        return t('errors.fieldError', { field: fieldLabel, reason: message });
    }
    return message.length > 0 ? message : t('common.requestFailed');
}
