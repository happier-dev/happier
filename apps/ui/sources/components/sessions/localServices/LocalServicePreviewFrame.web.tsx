import * as React from 'react';
import { View } from 'react-native';

const LOCAL_SERVICE_PREVIEW_ROUTE_PREFIXES = [
    '/v1/local-services/preview/',
    '/v1/local-services/public/',
] as const;

const LOCAL_SERVICE_PREVIEW_BASE_IFRAME_SANDBOX = [
    'allow-downloads',
    'allow-forms',
    'allow-modals',
    'allow-popups',
    'allow-scripts',
] as const;

const LOCAL_SERVICE_PREVIEW_HOST_ORIGIN_IFRAME_SANDBOX = [
    ...LOCAL_SERVICE_PREVIEW_BASE_IFRAME_SANDBOX,
    'allow-same-origin',
] as const;

const iframeStyle: React.CSSProperties = {
    border: 0,
    display: 'block',
    width: '100%',
    height: '100%',
};

function isPathModePreviewUrl(rawUrl: string): boolean {
    try {
        const url = new URL(rawUrl);
        return LOCAL_SERVICE_PREVIEW_ROUTE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
    } catch {
        return true;
    }
}

function resolvePreviewIframeSandbox(url: string): string {
    const entries = isPathModePreviewUrl(url)
        ? LOCAL_SERVICE_PREVIEW_BASE_IFRAME_SANDBOX
        : LOCAL_SERVICE_PREVIEW_HOST_ORIGIN_IFRAME_SANDBOX;
    return entries.join(' ');
}

export function LocalServicePreviewFrame(props: Readonly<{
    title: string;
    url: string;
    testID: string;
}>): React.ReactElement {
    return (
        <View
            testID={`${props.testID}-container`}
            style={{ flex: 1, minHeight: 0 }}
        >
            {React.createElement('iframe', {
                'data-testid': props.testID,
                referrerPolicy: 'no-referrer',
                sandbox: resolvePreviewIframeSandbox(props.url),
                src: props.url,
                style: iframeStyle,
                title: props.title,
            })}
        </View>
    );
}
