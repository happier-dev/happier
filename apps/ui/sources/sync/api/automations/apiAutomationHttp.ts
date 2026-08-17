import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';

export type AutomationApiErrorPayload = Readonly<{
    code: string;
    status: number;
    message?: string;
}>;

export class AutomationApiError extends HappyError {
    constructor(payload: AutomationApiErrorPayload) {
        super(
            payload.message ?? payload.code,
            payload.status === 408 || payload.status === 429 || payload.status >= 500,
            {
                code: payload.code,
                status: payload.status,
                kind: 'server',
            },
        );
        this.name = 'AutomationApiError';
        Object.setPrototypeOf(this, AutomationApiError.prototype);
    }
}

export function isAutomationApiErrorCode(error: unknown, code: string): error is AutomationApiError {
    return error instanceof AutomationApiError && error.code === code;
}

export async function readAutomationJsonOrThrow(response: Response): Promise<unknown> {
    if (!response.ok) {
        let message = `Automation API request failed: ${response.status}`;
        let code = 'automation_api_request_failed';
        try {
            const error = await response.json();
            const record = error && typeof error === 'object'
                ? error as Record<string, unknown>
                : null;
            if (typeof record?.error === 'string') {
                message = record.error;
                code = message;
            }
        } catch {
            // ignore
        }
        throw new AutomationApiError({ code, status: response.status, message });
    }
    return await response.json();
}

export function getAutomationAuthHeaders(
    credentials: AuthCredentials,
    options: Readonly<{ includeJsonContentType?: boolean }> = {},
): HeadersInit {
    const headers: HeadersInit = {
        Authorization: `Bearer ${credentials.token}`,
    };
    if (options.includeJsonContentType) {
        (headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    return headers;
}
