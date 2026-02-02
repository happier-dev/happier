import type { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { ChangesResponseSchema, CursorGoneErrorSchema, type ChangeEntry } from '@happier-dev/protocol/changes';

export async function fetchChanges(params: {
    credentials: AuthCredentials;
    afterCursor: string | null;
    limit: number;
}): Promise<
    | { status: 'ok'; changes: ChangeEntry[]; nextCursor: string }
    | { status: 'cursor-gone'; currentCursor: string }
    | { status: 'error' }
> {
    const after = (() => {
        if (!params.afterCursor) return 0;
        const n = Number(params.afterCursor);
        if (!Number.isFinite(n) || n < 0) return 0;
        return Math.floor(n);
    })();

    const limit = Number.isFinite(params.limit) ? Math.min(Math.max(Math.floor(params.limit), 1), 500) : 200;
    const url = `${getServerUrl()}/v2/changes?after=${after}&limit=${limit}`;

    let response: Response;
    try {
        response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${params.credentials.token}`,
                'Content-Type': 'application/json',
            },
        });
    } catch {
        return { status: 'error' };
    }

    if (response.status === 410) {
        try {
            const raw = await response.json();
            const parsed = CursorGoneErrorSchema.safeParse(raw);
            if (parsed.success) {
                return { status: 'cursor-gone', currentCursor: String(parsed.data.currentCursor) };
            }
        } catch {
            // ignore
        }
        return { status: 'cursor-gone', currentCursor: '0' };
    }

    if (!response.ok) {
        return { status: 'error' };
    }

    try {
        const raw = await response.json();
        const parsed = ChangesResponseSchema.safeParse(raw);
        if (!parsed.success) {
            return { status: 'error' };
        }
        return { status: 'ok', changes: parsed.data.changes, nextCursor: String(parsed.data.nextCursor) };
    } catch {
        return { status: 'error' };
    }
}
