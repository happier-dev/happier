import * as React from 'react';

import { t } from '@/text';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { validateServerUrl } from '@/sync/domains/server/serverConfig';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { canSafelyAutoAdoptCanonicalServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { fireAndForget } from '@/utils/system/fireAndForget';

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

        fireAndForget((async () => {
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
            const created = upsertServerProfile({
                serverUrl: normalized,
                name: defaultServerName(normalized),
                source: params.source,
            });

            let profile = created;
            try {
                const featuresSnapshot = await getServerFeaturesSnapshot({ serverId: created.id, force: true, timeoutMs: 1000 });
                if (featuresSnapshot.status === 'ready') {
                    const advertisedRaw = featuresSnapshot.features.capabilities?.server?.canonicalServerUrl;
                    const advertised = typeof advertisedRaw === 'string' ? normalizeUrl(advertisedRaw) : '';
                    if (advertised && advertised !== created.serverUrl && canSafelyAutoAdoptCanonicalServerUrl({ currentUrl: created.serverUrl, advertisedUrl: advertised })) {
                        const canonical = upsertServerProfile({
                            serverUrl: advertised,
                            name: created.name,
                            source: params.source,
                        });
                        if (canonical.id !== created.id) {
                            try {
                                removeServerProfile(created.id);
                            } catch {
                                // ignore; best-effort cleanup
                            }
                        }
                        profile = canonical;
                    }
                }
            } catch {
                // best-effort
            }

            await params.onSwitchServerById(profile.id, { normalizeRoute: false });
            params.onAfterSuccess();
        })(), {
            tag: 'useServerAutoAddFromRoute.autoAdd',
            onError: () => {
                params.setError(t('errors.operationFailed'));
            },
        });
    }, [params]);
}
