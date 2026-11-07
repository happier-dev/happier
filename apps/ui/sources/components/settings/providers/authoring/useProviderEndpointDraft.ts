import * as React from 'react';
import type { ProviderEndpointOverrideV1 } from '@happier-dev/protocol/providers/connections/v1';

type HeaderMap = NonNullable<ProviderEndpointOverrideV1['publicHeaders']>;
type EndpointDraft = Readonly<{ baseUrl?: string; publicHeaders?: HeaderMap }>;

/** Draft only the selected layer; inherited addresses and public headers remain unpinned. */
export function useProviderEndpointDraft(templates: readonly Readonly<{ id: string }>[]) {
    const [drafts, setDrafts] = React.useState<Readonly<Record<string, EndpointDraft>>>({});
    const setBaseUrl = React.useCallback((id: string, baseUrl: string) => {
        setDrafts(current => current[id]?.baseUrl === baseUrl ? current : {
            ...current, [id]: { ...current[id], baseUrl },
        });
    }, []);
    const setPublicHeaders = React.useCallback((id: string, publicHeaders: HeaderMap | null) => {
        setDrafts(current => {
            const previous = current[id];
            const nextHeaders = publicHeaders && Object.keys(publicHeaders).length > 0 ? publicHeaders : undefined;
            if (previous?.publicHeaders === nextHeaders) return current;
            const { publicHeaders: _headers, ...retained } = previous ?? {};
            return { ...current, [id]: { ...retained, ...(nextHeaders ? { publicHeaders: nextHeaders } : {}) } };
        });
    }, []);
    const reset = React.useCallback(() => setDrafts({}), []);
    const projection = React.useMemo(() => {
        const values: Record<string, string> = {};
        const publicHeaders: Record<string, HeaderMap> = {};
        const overrides: ProviderEndpointOverrideV1[] = [];
        for (const { id } of templates) {
            const draft = drafts[id];
            if (!draft) continue;
            if (draft.baseUrl !== undefined) values[id] = draft.baseUrl;
            if (draft.publicHeaders) publicHeaders[id] = draft.publicHeaders;
            const baseUrl = draft.baseUrl?.trim();
            if (baseUrl || draft.publicHeaders) overrides.push({ endpointTemplateId: id,
                ...(baseUrl ? { baseUrl } : {}), ...(draft.publicHeaders ? { publicHeaders: draft.publicHeaders } : {}) });
        }
        return { values, publicHeaders, overrides };
    }, [drafts, templates]);
    return { ...projection, setBaseUrl, setPublicHeaders, reset };
}
