import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierHtmlSandboxFrame } from '@happier-dev/plugin-ui/presentation';

import type { ArtifactBodyV1 } from '@happier-dev/protocol';
import type { ArtifactHtmlPreview } from '@/sync/domains/artifacts/artifactTypes';
import { HostedFrameHost } from '@/components/ui/surfaces/framed/HostedFrameHost';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

type Preview = Readonly<{ key: string; body: ArtifactBodyV1 | null | undefined }> & (
    | Readonly<{ phase: 'loading' | 'failed' }>
    | (Readonly<{ phase: 'ready' }> & ArtifactHtmlPreview)
);

/** Sync owns authorization and isolated URL delivery; this view owns the opened frame's lifetime. */
export function ArtifactHtmlBody(props: Readonly<{
    artifactId: string;
    headerVersion: number;
    bodyVersion?: number;
    body: ArtifactBodyV1 | null | undefined;
    name: string;
    readPreview: (artifactId: string, signal?: AbortSignal) => Promise<ArtifactHtmlPreview>;
    /** Private opened content prepared in the parent view's finite operation. */
    preview?: ArtifactHtmlPreview;
    onRetry?: () => void;
}>) {
    const { theme } = useUnistyles();
    const key = `${props.artifactId}:${props.headerVersion}:${props.bodyVersion ?? ''}`;
    const [preview, setPreview] = React.useState<Preview>({ key, body: props.body, phase: 'loading' });
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        const controller = new AbortController();
        const body = props.body;
        setPreview({ key, body, phase: 'loading' });
        void (props.preview ? Promise.resolve(props.preview) : props.readPreview(props.artifactId, controller.signal)).then(value => {
            if (controller.signal.aborted) return;
            const url = new URL(value.url);
            if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
                || (Platform.OS === 'web' && typeof window !== 'undefined' && url.origin === window.location.origin)) {
                throw new Error('HTML preview must use an isolated origin');
            }
            setPreview({ key, body, phase: 'ready', url: url.toString(), bundle: value.bundle });
        }).catch(() => {
            if (!controller.signal.aborted) setPreview({ key, body, phase: 'failed' });
        });
        return () => controller.abort();
    }, [key, props.artifactId, props.body, props.readPreview, props.preview, attempt]);

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
            action={{ label: t('common.retry'), testID: 'artifact:htmlPreviewRetry', onPress: props.onRetry ?? (() => setAttempt(value => value + 1)) }}
            accessibilitySemantics="alert"
        />}
        loading={<SurfaceStateCard
            testID="artifact:htmlPreviewLoading" kind="loading" title={t('common.loading')}
        />}
        host={{ renderFrame: ({ title, onError, nativeStyle }) => current?.phase === 'ready' ? <View style={nativeStyle}>
            <HostedFrameHost
                key={key}
                title={title}
                bundle={current.bundle}
                testID="artifact:htmlPreview"
                sandbox={{ scripts: true, sameOrigin: false, popups: false, topNavigation: false, mixedContent: false }}
                security={{
                    allowedNavigationOrigins: [], allowedCallbackOrigins: [], allowedConnectOrigins: [],
                    csp: { connectSrc: 'none', allowDataUrls: true, allowBlobUrls: false, allowInlineStyles: true, allowEval: false },
                    sourceMaps: 'disabled', mixedContent: 'deny',
                }}
                onError={onError}
                onUnexpectedNavigation={onError}
                onNativeHostedHtmlUnavailable={onError}
            />
        </View> : null }} />;
}
