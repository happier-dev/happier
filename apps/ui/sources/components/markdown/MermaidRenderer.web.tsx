import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { useInitialPresentationProducer } from '@/components/ui/presentation/InitialPresentationReadinessContext';
import { sanitizeRenderedMermaidSvg } from './mermaidSanitize';

const webStyle: React.CSSProperties = {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 16,
    overflow: 'auto',
};

const WebDiv: React.ElementType<{
    style?: React.CSSProperties;
    dangerouslySetInnerHTML?: { __html: string };
}> = 'div';

export const MermaidRenderer = React.memo((props: {
    content: string;
}) => {
    const [renderState, setRenderState] = React.useState<Readonly<{
        content: string;
        status: 'error' | 'pending' | 'ready';
        svg: string | null;
    }>>(() => ({
        content: props.content,
        status: 'pending',
        svg: null,
    }));
    const copyFeedback = useTemporaryCopyFeedback();
    const currentRenderState = renderState.content === props.content
        ? renderState
        : { content: props.content, status: 'pending' as const, svg: null };
    useInitialPresentationProducer({
        producerKey: `mermaid:${props.content}`,
        terminal: currentRenderState.status !== 'pending',
    });

    const copyMermaid = React.useCallback(async () => {
        const copied = await setClipboardStringSafe(props.content);
        if (copied) {
            copyFeedback.markCopied('mermaid');
            return;
        }
        Modal.alert(t('common.error'), t('markdown.copyFailed'), [{ text: t('common.ok'), style: 'cancel' }]);
    }, [copyFeedback, props.content]);

    React.useEffect(() => {
        let isMounted = true;

        const renderMermaid = async () => {
            try {
                const mermaidModule = await import('mermaid');
                const mermaid = mermaidModule.default;
                mermaid.initialize({
                    startOnLoad: false,
                    theme: 'dark',
                });
                const { svg } = await mermaid.render(`mermaid-${Date.now()}`, props.content);
                if (isMounted) {
                    setRenderState({
                        content: props.content,
                        status: 'ready',
                        svg: sanitizeRenderedMermaidSvg(svg),
                    });
                }
            } catch {
                if (isMounted) {
                    setRenderState({
                        content: props.content,
                        status: 'error',
                        svg: null,
                    });
                }
            }
        };

        void renderMermaid();
        return () => {
            isMounted = false;
        };
    }, [props.content]);

    if (currentRenderState.status === 'error') {
        return (
            <View testID="mermaid-render-error" style={[style.container, style.errorContainer]}>
                <View style={style.errorContent}>
                    <Text style={style.errorText}>{t('markdown.mermaidRenderFailed')}</Text>
                    <View style={style.codeBlock}>
                        <Text testID="mermaid-error-source" style={style.codeText}>{props.content}</Text>
                    </View>
                </View>
            </View>
        );
    }

    if (currentRenderState.status !== 'ready' || !currentRenderState.svg) {
        return (
            <View style={[style.container, style.loadingContainer]}>
                <View style={style.loadingPlaceholder} />
            </View>
        );
    }

    return (
        <View style={style.container}>
            <View style={style.diagramWrapper}>
                <View style={style.copyButtonWrapper}>
                    <Pressable testID="mermaid-copy-button" style={style.copyButton} onPress={copyMermaid}>
                        {copyFeedback.isCopied('mermaid') ? (
                            <CopiedPill visible testID="mermaid-copy-feedback" />
                        ) : (
                            <Text style={style.copyButtonText}>{t('common.copy')}</Text>
                        )}
                    </Pressable>
                </View>
                <WebDiv
                    style={webStyle}
                    dangerouslySetInnerHTML={{ __html: currentRenderState.svg }}
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
    diagramWrapper: {
        position: 'relative',
        width: '100%',
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
    loadingContainer: {
        justifyContent: 'center',
        alignItems: 'center',
        height: 100,
    },
    loadingPlaceholder: {
        width: 200,
        height: 20,
        backgroundColor: theme.colors.border.default,
        borderRadius: 4,
    },
    errorContainer: {
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 8,
        padding: 16,
    },
    errorContent: {
        flexDirection: 'column',
        gap: 12,
    },
    errorText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 16,
    },
    codeBlock: {
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 4,
        padding: 12,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
        fontSize: 14,
        lineHeight: 20,
    },
}));
