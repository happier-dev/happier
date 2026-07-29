import * as React from 'react';
import { Pressable, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { MERMAID_WEBVIEW_BUNDLE_JS } from './mermaidWebViewBundle.generated';

const MAX_MERMAID_WEBVIEW_MESSAGE_BYTES = 1_024;
const MAX_MERMAID_WEBVIEW_HEIGHT_PX = 100_000;
const MERMAID_WEBVIEW_INJECTED_JAVASCRIPT = `${MERMAID_WEBVIEW_BUNDLE_JS}\ntrue;`;

type MermaidWebViewMessage =
    | Readonly<{ type: 'dimensions'; height: number }>
    | Readonly<{ type: 'error' }>;

export function parseMermaidWebViewMessage(raw: unknown): MermaidWebViewMessage | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_MERMAID_WEBVIEW_MESSAGE_BYTES) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.type === 'error') return { type: 'error' };
    if (
        record.type !== 'dimensions'
        || typeof record.height !== 'number'
        || !Number.isFinite(record.height)
        || record.height <= 0
        || record.height > MAX_MERMAID_WEBVIEW_HEIGHT_PX
    ) {
        return null;
    }
    return { type: 'dimensions', height: Math.ceil(record.height) };
}

export function shouldAllowMermaidWebViewNavigation(url: string): boolean {
    return url === 'about:blank';
}

export const MermaidRenderer = React.memo((props: {
    content: string;
}) => {
    const { theme } = useUnistyles();
    const [dimensions, setDimensions] = React.useState({ width: 0, height: 200 });
    const copyFeedback = useTemporaryCopyFeedback();

    const copyMermaid = React.useCallback(async () => {
        const copied = await setClipboardStringSafe(props.content);
        if (copied) {
            copyFeedback.markCopied('mermaid');
            return;
        }
        Modal.alert(t('common.error'), t('markdown.copyFailed'), [{ text: t('common.ok'), style: 'cancel' }]);
    }, [copyFeedback, props.content]);

    const onLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
        const { width } = event.nativeEvent.layout;
        setDimensions(prev => ({ ...prev, width }));
    }, []);

    // Never interpolate Mermaid source into HTML; treat it as data to prevent XSS.
    // Escape '<' so sequences like '</script>' cannot terminate the script tag.
    const mermaidContentLiteral = React.useMemo(
        () => JSON.stringify(props.content).replace(/</g, '\\u003c'),
        [props.content],
    );
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; media-src 'none'; font-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
            <style>
                body {
                    margin: 0;
                    padding: 16px;
                    background-color: ${theme.colors.surface.elevated};
                }
                #mermaid-container {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    width: 100%;
                }
                #mermaid-container svg {
                    max-width: 100%;
                    height: auto;
                }
                .error {
                    color: #ff6b6b;
                    font-family: monospace;
                    white-space: pre-wrap;
                }
            </style>
        </head>
        <body>
            <div id="mermaid-container"></div>
            <script>
                (async function() {
                    const content = ${mermaidContentLiteral};
                    const container = document.getElementById('mermaid-container');

                    try {
                        const mermaid = globalThis.HAPPIER_MERMAID;
                        const removeNavigation = globalThis.HAPPIER_MERMAID_REMOVE_NAVIGATION;
                        if (!mermaid || typeof mermaid.initialize !== 'function' || typeof mermaid.render !== 'function') {
                            throw new Error('Bundled Mermaid runtime is unavailable');
                        }
                        if (typeof removeNavigation !== 'function') {
                            throw new Error('Bundled Mermaid output policy is unavailable');
                        }
                        mermaid.initialize({
                            startOnLoad: false,
                            theme: 'dark',
                            securityLevel: 'strict'
                        });

                        const { svg } = await mermaid.render('mermaid-diagram', content);
                        const template = document.createElement('template');
                        template.innerHTML = svg;
                        removeNavigation(template.content);
                        container.replaceChildren(template.content);

                        const height = Math.max(document.body.scrollHeight || 0, container.scrollHeight || 0);
                        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dimensions', height: height }));
                        }
                    } catch (error) {
                        const raw = (error && error.message) ? String(error.message) : String(error);
                        const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        container.innerHTML = '<div class="error">Diagram error: ' + escaped + '</div>';
                        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error' }));
                        }
                    }
                })();
            </script>
        </body>
        </html>
    `;

    return (
        <View style={style.container} onLayout={onLayout}>
            <View style={[style.innerContainer, { height: dimensions.height }]}>
                <View style={style.copyButtonWrapper}>
                    <Pressable testID="mermaid-copy-button" style={style.copyButton} onPress={copyMermaid}>
                        {copyFeedback.isCopied('mermaid') ? (
                            <CopiedPill visible testID="mermaid-copy-feedback" />
                        ) : (
                            <Text style={style.copyButtonText}>{t('common.copy')}</Text>
                        )}
                    </Pressable>
                </View>
                <WebView
                    source={{ html }}
                    style={{ flex: 1 }}
                    scrollEnabled={false}
                    originWhitelist={['*']}
                    onShouldStartLoadWithRequest={(request) => shouldAllowMermaidWebViewNavigation(request.url)}
                    injectedJavaScriptBeforeContentLoaded={MERMAID_WEBVIEW_INJECTED_JAVASCRIPT}
                    injectedJavaScriptForMainFrameOnly
                    javaScriptCanOpenWindowsAutomatically={false}
                    setSupportMultipleWindows={false}
                    mixedContentMode="never"
                    allowFileAccess={false}
                    allowUniversalAccessFromFileURLs={false}
                    cacheEnabled={false}
                    incognito
                    domStorageEnabled={false}
                    sharedCookiesEnabled={false}
                    thirdPartyCookiesEnabled={false}
                    onMessage={(event) => {
                        const data = parseMermaidWebViewMessage(event.nativeEvent.data);
                        if (data?.type === 'dimensions') {
                            setDimensions(prev => ({
                                ...prev,
                                height: Math.max(prev.height, data.height),
                            }));
                        }
                    }}
                />
            </View>
        </View>
    );
});

const style = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
        width: '100%',
    },
    innerContainer: {
        width: '100%',
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 8,
    },
    copyButtonWrapper: {
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        opacity: 0.9,
    },
    copyButton: {
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    copyButtonText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 12,
    },
}));
