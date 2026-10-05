import * as React from 'react';
import { Platform, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import {
    WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
} from '@/components/ui/text/webStartEllipsisTextStyles';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { FindHighlightedText, sliceFindRanges } from '@/components/ui/text/FindHighlightedText';

const PATH_SEPARATOR = '/';

export type InlineRepoPathLabelProps = Readonly<{
    fileName?: string | null;
    filePath?: string | null;
    fullPath?: string | null;
    nameSuffix?: string;
    alignForRootFiles?: boolean;
    style?: StyleProp<ViewStyle>;
    pathTextStyle?: StyleProp<TextStyle>;
    nameTextStyle?: StyleProp<TextStyle>;
    nameMaxWidth?: number | `${number}%`;
    /**
     * When true, the basename keeps priority over the directory: it may grow to the
     * full available width (lifting `nameMaxWidth`) so the path is the first to be
     * truncated (head-ellipsized down to `…/`). The filename is only ever
     * middle-ellipsized once it alone needs the entire row.
     */
    preferNameOverPath?: boolean;
    /**
     * `inline` (default): `folder/` then the name on one line. `stacked`: the name first, its folder
     * beneath (head-truncated, so the meaningful end stays) — the Git change row (session-tabs G1).
     * `nameFirst`: the name, then its folder after it on the same line (the compact changed-file row).
     */
    layout?: 'inline' | 'stacked' | 'nameFirst';
    /**
     * The other paths in the same list. When one shares this file's name, the name line is prefixed
     * with the nearest folders that tell them apart (`attack-conclusion/SKILL.md`), the way editor
     * tabs do. Passing only the paths that share the name is enough.
     */
    siblingPaths?: readonly string[];
    /** The folder line for a file at the repository root (the repository's name). Stacked only. */
    rootLabel?: string | null;
    /** Replaces the folder line (a rename's "was …"). Stacked only. */
    detail?: string | null;
    /** UTF-16 offsets into the normalized inline path. */
    findRanges?: readonly FindTextRange[];
    /** Offsets into the independent rename/detail label, when displayed beside the full path for Find. */
    detailFindRanges?: readonly FindTextRange[];
}>;

function splitDir(dir: string | null): string[] {
    return dir ? dir.split(PATH_SEPARATOR).filter(Boolean) : [];
}

/**
 * The shortest run of trailing folders that tells `fullPath` apart from every sibling with the same
 * file name ('' when the name is already unique, or when no folder can separate them).
 */
export function resolveDistinguishingFolderPrefix(fullPath: string, siblingPaths: readonly string[]): string {
    const own = normalizeRepoPathParts({ fullPath });
    const ownDir = splitDir(own.dir);
    const rivals = siblingPaths
        .map((path) => normalizeRepoPathParts({ fullPath: path }))
        .filter((parts) => parts.name === own.name && (parts.dir ?? '') !== (own.dir ?? ''))
        .map((parts) => splitDir(parts.dir));
    if (rivals.length === 0 || ownDir.length === 0) return '';
    const tail = (segments: readonly string[], count: number) => segments.slice(Math.max(0, segments.length - count)).join(PATH_SEPARATOR);
    for (let count = 1; count <= ownDir.length; count += 1) {
        const candidate = tail(ownDir, count);
        if (rivals.every((dir) => tail(dir, count) !== candidate)) return candidate;
    }
    return own.dir ?? '';
}

export const InlineRepoPathLabel = React.memo(function InlineRepoPathLabel(props: InlineRepoPathLabelProps) {
    const { dir, name } = React.useMemo(() => {
        return normalizeRepoPathParts({
            fileName: props.fileName,
            filePath: props.filePath,
            fullPath: props.fullPath,
        });
    }, [props.fileName, props.filePath, props.fullPath]);

    const isWeb = Platform.OS === 'web';
    const stacked = props.layout === 'stacked';
    const dirLabel = dir ? `${dir}${PATH_SEPARATOR}` : null;
    const disambiguation = React.useMemo(() => {
        if (props.layout === 'inline' || props.layout === undefined || !props.siblingPaths || props.siblingPaths.length === 0) return '';
        return resolveDistinguishingFolderPrefix(dir ? `${dir}${PATH_SEPARATOR}${name}` : name, props.siblingPaths);
    }, [dir, name, props.layout, props.siblingPaths]);
    const containerStyle = React.useMemo<StyleProp<ViewStyle>>(() => {
        return [
            stacked
                ? ({ flex: 1, minWidth: 0, flexDirection: 'column' as const, justifyContent: 'center' as const } satisfies ViewStyle)
                : ({
                    flex: 1,
                    minWidth: 0,
                    flexDirection: 'row' as const,
                    alignItems: 'baseline' as const,
                } satisfies ViewStyle),
            props.style,
        ];
    }, [props.style, stacked]);
    const pathStyle = React.useMemo<StyleProp<TextStyle>>(() => {
        return [
            stacked ? { minWidth: 0 } : { flex: 1, minWidth: 0 },
            isWeb
                ? [WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE, { textAlign: stacked ? 'left' : 'right' } satisfies TextStyle]
                : { textAlign: stacked ? 'left' : 'right' } satisfies TextStyle,
            props.pathTextStyle,
        ];
    }, [isWeb, props.pathTextStyle, stacked]);
    const effectiveNameMaxWidth = props.preferNameOverPath ? '100%' : (props.nameMaxWidth ?? null);
    const nameStyle = React.useMemo<StyleProp<TextStyle>>(() => {
        return [
            {
                flexShrink: 0,
            },
            effectiveNameMaxWidth != null ? { maxWidth: effectiveNameMaxWidth } : null,
            props.nameTextStyle,
        ];
    }, [effectiveNameMaxWidth, props.nameTextStyle]);

    if (props.layout === 'nameFirst') {
        const finding = props.findRanges !== undefined;
        const folderLine = finding ? dirLabel : (props.detail ?? dir);
        return (
            <View style={[{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }, props.style]}>
                <Text testID="repo-path-label-name" numberOfLines={finding ? undefined : 1} ellipsizeMode="middle" style={[{ flexShrink: 0, maxWidth: '100%' }, props.nameTextStyle]}>
                    {disambiguation ? <Text style={props.pathTextStyle}>{`${disambiguation}${PATH_SEPARATOR}`}</Text> : null}
                    {props.findRanges?.length ? <FindHighlightedText text={`${name}${props.nameSuffix ?? ''}`} ranges={sliceFindRanges(props.findRanges, dirLabel?.length ?? 0, name.length + (props.nameSuffix?.length ?? 0))} /> : `${name}${props.nameSuffix ?? ''}`}
                </Text>
                {folderLine ? (
                    <Text
                        testID="repo-path-label-folder"
                        numberOfLines={finding ? undefined : 1}
                        ellipsizeMode={isWeb ? undefined : 'head'}
                        style={[{ flex: 1, minWidth: 0 }, isWeb ? WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE : null, props.pathTextStyle]}
                    >
                        {isWeb ? <Text style={WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE}>{finding && props.findRanges?.length ? <FindHighlightedText text={folderLine} ranges={sliceFindRanges(props.findRanges, 0, folderLine.length)} /> : folderLine}</Text> : finding && props.findRanges?.length ? <FindHighlightedText text={folderLine} ranges={sliceFindRanges(props.findRanges, 0, folderLine.length)} /> : folderLine}
                    </Text>
                ) : null}
                {finding && props.detail ? <Text testID="repo-path-label-detail" style={props.pathTextStyle}>{props.detailFindRanges?.length ? <FindHighlightedText text={props.detail} ranges={props.detailFindRanges} /> : props.detail}</Text> : null}
            </View>
        );
    }

    if (stacked) {
        const folderLine = props.detail ?? dir ?? props.rootLabel ?? null;
        return (
            <View style={containerStyle}>
                <Text testID="repo-path-label-name" numberOfLines={1} ellipsizeMode="middle" style={props.nameTextStyle}>
                    {disambiguation ? (
                        <Text style={props.pathTextStyle}>{`${disambiguation}${PATH_SEPARATOR}`}</Text>
                    ) : null}
                    {`${name}${props.nameSuffix ?? ''}`}
                </Text>
                {folderLine ? (
                    <Text
                        testID="repo-path-label-folder"
                        numberOfLines={1}
                        ellipsizeMode={isWeb ? undefined : 'head'}
                        style={pathStyle}
                    >
                        {isWeb ? (
                            <Text style={WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE}>{folderLine}</Text>
                        ) : folderLine}
                    </Text>
                ) : null}
            </View>
        );
    }

    return (
        <View style={containerStyle}>
            {dirLabel ? (
                <Text numberOfLines={props.findRanges?.length ? undefined : 1} ellipsizeMode={isWeb ? undefined : 'head'} style={pathStyle}>
                    {isWeb ? (
                        <Text style={WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE}>
                            {props.findRanges?.length ? <FindHighlightedText text={dirLabel} ranges={sliceFindRanges(props.findRanges, 0, dirLabel.length)} /> : dirLabel}
                        </Text>
                    ) : props.findRanges?.length ? <FindHighlightedText text={dirLabel} ranges={sliceFindRanges(props.findRanges, 0, dirLabel.length)} /> : dirLabel}
                </Text>
            ) : props.alignForRootFiles === false ? null : (
                <View style={{ flex: 1, minWidth: 0 }} />
            )}
            <Text numberOfLines={props.findRanges?.length ? undefined : 1} ellipsizeMode="middle" style={nameStyle}>
                {props.findRanges?.length ? <FindHighlightedText text={`${name}${props.nameSuffix ?? ''}`} ranges={sliceFindRanges(props.findRanges, dirLabel?.length ?? 0, name.length + (props.nameSuffix?.length ?? 0))} /> : `${name}${props.nameSuffix ?? ''}`}
            </Text>
        </View>
    );
});
