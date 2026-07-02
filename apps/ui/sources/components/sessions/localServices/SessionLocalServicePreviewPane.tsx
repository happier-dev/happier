import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    resolveLocalServicePreviewLoadUrl,
    type LocalServicePreviewPlatform,
} from '@/sync/domains/local/services/preview/url';
import type { LocalServicePreviewRow } from '@/sync/domains/local/services/preview/store';
import { t } from '@/text';

import { LocalServicePreviewFrame } from './LocalServicePreviewFrame';

type PreviewUnavailableReason =
    | 'missing_preview'
    | 'access_url_unavailable'
    | 'expired'
    | 'invalid_url'
    | 'native_loopback_not_allowed'
    | 'unsupported_scheme';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    header: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        gap: 3,
    },
    title: {
        color: theme.colors.text.primary,
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        ...Typography.default(),
    },
    unavailable: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backgroundColor: theme.colors.surface.base,
    },
    unavailableText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

function resolvePlatform(platform: LocalServicePreviewPlatform | undefined): LocalServicePreviewPlatform {
    if (platform) {
        return platform;
    }
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
        return Platform.OS;
    }
    return 'web';
}

function resolveUnavailableReason(params: Readonly<{
    preview: LocalServicePreviewRow | null | undefined;
    platform: LocalServicePreviewPlatform;
    nowMs: number;
}>): PreviewUnavailableReason | null {
    if (!params.preview) {
        return 'missing_preview';
    }
    if (!params.preview.accessUrl) {
        return 'access_url_unavailable';
    }
    if (typeof params.preview.expiresAt === 'number' && params.preview.expiresAt <= params.nowMs) {
        return 'expired';
    }

    const loadUrl = resolveLocalServicePreviewLoadUrl({
        platform: params.platform,
        url: params.preview.accessUrl,
    });
    return loadUrl.ok ? null : loadUrl.reasonCode;
}

function resolveFrameUrl(params: Readonly<{
    preview: LocalServicePreviewRow;
    platform: LocalServicePreviewPlatform;
}>): string | null {
    if (!params.preview.accessUrl) {
        return null;
    }
    const loadUrl = resolveLocalServicePreviewLoadUrl({
        platform: params.platform,
        url: params.preview.accessUrl,
    });
    return loadUrl.ok ? loadUrl.url : null;
}

export function SessionLocalServicePreviewPane(props: Readonly<{
    preview: LocalServicePreviewRow | null | undefined;
    platform?: LocalServicePreviewPlatform;
    nowMs?: () => number;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'local-service-preview-pane';
    const platform = resolvePlatform(props.platform);
    const nowMs = props.nowMs?.() ?? Date.now();
    const unavailableReason = resolveUnavailableReason({
        preview: props.preview,
        platform,
        nowMs,
    });
    const styles = stylesheet;

    if (unavailableReason || !props.preview) {
        return (
            <View testID={`${testID}-unavailable-${unavailableReason ?? 'missing_preview'}`} style={styles.unavailable}>
                <Text style={styles.unavailableText}>{t('common.unavailable')}</Text>
            </View>
        );
    }

    const frameUrl = resolveFrameUrl({
        preview: props.preview,
        platform,
    });
    if (!frameUrl) {
        return (
            <View testID={`${testID}-unavailable-invalid_url`} style={styles.unavailable}>
                <Text style={styles.unavailableText}>{t('common.unavailable')}</Text>
            </View>
        );
    }

    return (
        <View testID={testID} style={styles.root}>
            <View style={styles.header}>
                <Text style={styles.title}>{props.preview.resource.display.title}</Text>
                <Text style={styles.subtitle}>{props.preview.resource.display.addressLabel}</Text>
            </View>
            <LocalServicePreviewFrame
                title={props.preview.resource.display.title}
                url={frameUrl}
                testID={`${testID}-frame`}
            />
        </View>
    );
}
