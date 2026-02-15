import type { AuthCredentials } from '@/auth/storage/tokenStorage';

export async function readAutomationJsonOrThrow(response: Response): Promise<unknown> {
    if (!response.ok) {
        let message = `Automation API request failed: ${response.status}`;
        try {
            const error = await response.json();
            if (error && typeof error === 'object' && typeof (error as any).error === 'string') {
                message = (error as any).error;
            }
        } catch {
            // ignore
        }
        throw new Error(message);
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
