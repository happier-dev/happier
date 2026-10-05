import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierHtmlSandboxFrame } from '@happier-dev/plugin-ui/presentation';
import { WebView } from 'react-native-webview';

import type { ArtifactBodyV1 } from '@happier-dev/protocol';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

type Preview = Readonly<{ key: string; body: ArtifactBodyV1 | null | undefined }> & (
    | Readonly<{ phase: 'loading' | 'failed' }>
    | Readonly<{ phase: 'ready'; url: string; origin: string }>
);

// Installed React types omit this browser attribute, and React drops unknown boolean props.
const credentiallessIframeAttributes = { credentialless: '' } satisfies
    React.IframeHTMLAttributes<HTMLIFrameElement> & Readonly<{ credentialless: '' }>;

/** Sync owns authorization and isolated URL delivery; this view owns the opened frame's lifetime. */
export function ArtifactHtmlBody(props: Readonly<{
    artifactId: string;
    headerVersion: number;
    bodyVersion?: number;
    body: ArtifactBodyV1 | null | undefined;
    name: string;
    readPreviewUrl: (artifactId: string, signal?: AbortSignal) => Promise<string>;
}>) {
    const { theme } = useUnistyles();
    const key = `${props.artifactId}:${props.headerVersion}:${props.bodyVersion ?? ''}`;
    const [preview, setPreview] = React.useState<Preview>({ key, body: props.body, phase: 'loading' });
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        const controller = new AbortController();
        const body = props.body;
        setPreview({ key, body, phase: 'loading' });
        void props.readPreviewUrl(props.artifactId, controller.signal).then(value => {
            if (controller.signal.aborted) return;
            const url = new URL(value);
            if (url.protocol !== 'https:' || url.username || url.password
                || (Platform.OS === 'web' && typeof window !== 'undefined' && url.origin === window.location.origin)) {
                throw new Error('HTML preview must use an isolated origin');
            }
            setPreview({ key, body, phase: 'ready', url: url.toString(), origin: url.origin });
        }).catch(() => {
            if (!controller.signal.aborted) setPreview({ key, body, phase: 'failed' });
        });
        return () => controller.abort();
    }, [key, props.artifactId, props.body, props.readPreviewUrl, attempt]);

    const current = preview.key === key && preview.body === props.body ? preview : null;
    const fail = () => setPreview(value => value === current ? { key, body: props.body, phase: 'failed' } : value);
    return <HappierHtmlSandboxFrame testID="artifact:htmlBody" title={props.name}
        backgroundColor={theme.colors.surface.elevated}
        state={current?.phase === 'ready' ? current : { phase: current?.phase ?? 'loading' }}
        onError={fail}
        failure={<SurfaceStateCard
            testID="artifact:htmlPreviewFailed"
            kind="error"
            title={t('artifacts.error')}
            reason={t('artifacts.browser.loadFailedBody')}
            action={{ label: t('common.retry'), testID: 'artifact:htmlPreviewRetry', onPress: () => setAttempt(value => value + 1) }}
            accessibilitySemantics="alert"
        />}
        loading={<SurfaceStateCard
            testID="artifact:htmlPreviewLoading" kind="loading" title={t('common.loading')}
        />}
        host={{ renderFrame: ({ url, title, onError, webStyle, nativeStyle }) => Platform.OS === 'web' ? <iframe
            key={url}
            data-testid="artifact:htmlPreview"
            src={url}
            title={title}
            sandbox="allow-scripts allow-same-origin"
            {...credentiallessIframeAttributes}
            referrerPolicy="no-referrer"
            onError={onError}
            style={webStyle}
        /> : <WebView
            key={url}
            testID="artifact:htmlPreview"
            source={{ uri: url }}
            accessibilityLabel={title}
            style={nativeStyle}
            // Non-whitelisted URLs launch the OS browser before the SDK's guard; route every URL through our guard.
            originWhitelist={['*']}
            incognito
            cacheEnabled={false}
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            mixedContentMode="never"
            javaScriptEnabled
            javaScriptCanOpenWindowsAutomatically={false}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            onShouldStartLoadWithRequest={request => {
                if (request.isTopFrame === false) return true;
                try {
                    const target = new URL(request.url);
                    return target.origin === new URL(url).origin && !target.username && !target.password;
                } catch { return false; }
            }}
            onError={onError}
            onHttpError={onError}
        /> }} />;
}
