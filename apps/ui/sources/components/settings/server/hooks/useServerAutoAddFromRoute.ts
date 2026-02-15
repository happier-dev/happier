import * as React from 'react';

import { t } from '@/text';
import { validateServerUrl } from '@/sync/domains/server/serverConfig';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';

function normalizeUrl(raw: string): string {
    return canonicalizeServerUrl(raw);
}

function defaultServerName(rawUrl: string): string {
    const url = normalizeUrl(rawUrl);
    try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        if (!host) return url;
        return parsed.port ? `${host}:${parsed.port}` : host;
    } catch {
        return url;
    }
}

export function useServerAutoAddFromRoute(params: Readonly<{
    enabled: boolean;
    url: string | null;
    validateServerReachable: (url: string) => Promise<boolean>;
    setError: (value: string | null) => void;
    onSwitchServerById: (serverId: string, opts?: { normalizeRoute?: boolean }) => Promise<void>;
    onAfterSuccess: () => void;
    source: 'url' | 'manual';
}>) {
    const handledRef = React.useRef(false);

    React.useEffect(() => {
        if (!params.enabled) return;
        if (!params.url) return;
        if (handledRef.current) return;
        handledRef.current = true;

        void (async () => {
            const url = params.url;
            if (!url) return;
            const validation = validateServerUrl(url);
            if (!validation.valid) {
                params.setError(validation.error || t('errors.invalidFormat'));
                return;
            }

            const isValid = await params.validateServerReachable(url);
            if (!isValid) return;

            const normalized = normalizeUrl(url);
            const profile = upsertServerProfile({
                serverUrl: normalized,
                name: defaultServerName(normalized),
                source: params.source,
            });

            await params.onSwitchServerById(profile.id, { normalizeRoute: false });
            params.onAfterSuccess();
        })();
    }, [params]);
}
