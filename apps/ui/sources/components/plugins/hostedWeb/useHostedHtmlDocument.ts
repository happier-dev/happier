import * as React from 'react';

import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import { buildHostedHtmlDocument } from './buildHostedHtmlDocument';

type HostedHtmlDocumentState = Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'ready'; document: string }>
    | Readonly<{ kind: 'error' }>;
const PENDING_DOCUMENT: HostedHtmlDocumentState = Object.freeze({ kind: 'loading' });

/** Async document preparation cannot publish a previous frame's source. */
export function useHostedHtmlDocument(
    bundle: Parameters<typeof buildHostedHtmlDocument>[0] | null,
    bootstrapConfig: Parameters<typeof buildHostedHtmlDocument>[1],
    isolation: Parameters<typeof buildHostedHtmlDocument>[2],
): HostedHtmlDocumentState {
    const networkOrigins = isolation?.networkOrigins;
    const network = isolation?.network;
    const externalHttpLinks = isolation?.externalHttpLinks;
    const generatedArtifactNonce = isolation?.generatedArtifactNonce;
    const pluginAuthored = isolation?.pluginAuthored;
    const bundleKey = React.useMemo(() => stableJsonStringify(bundle), [bundle]);
    const configurationKey = React.useMemo(() => stableJsonStringify({
        bootstrapConfig, networkOrigins, network, externalHttpLinks, generatedArtifactNonce, pluginAuthored,
    }), [bootstrapConfig, networkOrigins, network, externalHttpLinks, generatedArtifactNonce, pluginAuthored]);
    // Preparation belongs to the document's facts, not caller object identity.
    // In particular, recording guest readiness must not remove the same frame
    // and retire the bridge that just became ready. Keep bundle serialization
    // separate so fresh bootstrap objects do not rescan unchanged document bytes.
    const request = React.useMemo(() => bundle === null ? null : {
        bundle, bootstrapConfig, isolation: { networkOrigins, network, externalHttpLinks, generatedArtifactNonce, pluginAuthored },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- complete semantic keys retain equivalent immutable inputs.
    }, [bundleKey, configurationKey]);
    const [result, setResult] = React.useState<Readonly<{
        request: typeof request;
        state: HostedHtmlDocumentState;
    }> | null>(null);
    React.useEffect(() => {
        if (request === null) return;
        let current = true;
        void buildHostedHtmlDocument(request.bundle, request.bootstrapConfig, request.isolation).then(document => {
            if (current) setResult({ request, state: { kind: 'ready', document } });
        }).catch(() => {
            if (current) setResult({ request, state: { kind: 'error' } });
        });
        return () => { current = false; };
    }, [request]);
    return result?.request === request ? result.state : PENDING_DOCUMENT;
}
